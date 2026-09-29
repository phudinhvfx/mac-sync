#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>

// Native macOS companion for mac-sync.mjs. CDP remains responsible for web
// content; this process mirrors Chrome's own tab strip, toolbar, extension
// buttons, menus and side-panel toggle through Accessibility.

typedef struct { CGFloat x; CGFloat y; CGFloat width; CGFloat height; } Bounds;

static void emitLog(NSString *message) {
  printf("[AX UI] %s\n", message.UTF8String);
  fflush(stdout);
}

static BOOL boundsForElement(AXUIElementRef element, Bounds *result) {
  CFTypeRef positionValue = NULL, sizeValue = NULL;
  if (AXUIElementCopyAttributeValue(element, kAXPositionAttribute, &positionValue) != kAXErrorSuccess ||
      AXUIElementCopyAttributeValue(element, kAXSizeAttribute, &sizeValue) != kAXErrorSuccess) {
    if (positionValue) CFRelease(positionValue); if (sizeValue) CFRelease(sizeValue); return NO;
  }
  CGPoint point = CGPointZero; CGSize size = CGSizeZero;
  BOOL valid = AXValueGetValue((AXValueRef)positionValue, kAXValueCGPointType, &point) && AXValueGetValue((AXValueRef)sizeValue, kAXValueCGSizeType, &size);
  CFRelease(positionValue); CFRelease(sizeValue);
  if (!valid) return NO;
  *result = (Bounds){ point.x, point.y, size.width, size.height };
  return YES;
}

static BOOL containsPoint(Bounds bounds, CGPoint point) {
  return point.x >= bounds.x && point.x <= bounds.x + bounds.width && point.y >= bounds.y && point.y <= bounds.y + bounds.height;
}

static BOOL elementSupportsAction(AXUIElementRef element, CFStringRef wantedAction) {
  CFArrayRef actions = NULL;
  if (AXUIElementCopyActionNames(element, &actions) != kAXErrorSuccess || !actions) return NO;
  BOOL supported = NO;
  for (CFIndex index = 0; index < CFArrayGetCount(actions); index += 1) {
    if (CFEqual(CFArrayGetValueAtIndex(actions, index), wantedAction)) { supported = YES; break; }
  }
  CFRelease(actions);
  return supported;
}

static NSString *stringAttribute(AXUIElementRef element, CFStringRef attribute) {
  CFTypeRef value = NULL;
  if (AXUIElementCopyAttributeValue(element, attribute, &value) != kAXErrorSuccess || !value) return @"-";
  NSString *result = CFGetTypeID(value) == CFStringGetTypeID() ? [NSString stringWithString:(NSString *)value] : @"-";
  CFRelease(value);
  return result;
}

// Intentionally omits title/value so the control log can diagnose Chrome UI
// structure without recording page titles, URLs, or text typed by the user.
static NSString *elementSummary(AXUIElementRef element) {
  CFArrayRef actions = NULL;
  NSMutableArray *actionNames = [NSMutableArray array];
  if (AXUIElementCopyActionNames(element, &actions) == kAXErrorSuccess && actions) {
    for (CFIndex index = 0; index < CFArrayGetCount(actions); index += 1) {
      CFTypeRef action = CFArrayGetValueAtIndex(actions, index);
      if (CFGetTypeID(action) == CFStringGetTypeID()) [actionNames addObject:(NSString *)action];
    }
    CFRelease(actions);
  }
  return [NSString stringWithFormat:@"role=%@ subrole=%@ actions=%@", stringAttribute(element, kAXRoleAttribute), stringAttribute(element, kAXSubroleAttribute), actionNames.count ? [actionNames componentsJoinedByString:@","] : @"-"];
}

// Chrome can expose the visual part hit by a tab-strip click as an image or a
// group. Walk to the nearest actionable parent, so the same generic path
// handles a tab body and its close button without extension-specific rules.
static AXUIElementRef copyClosestPressableElement(AXUIElementRef hitElement, NSUInteger *depthOut) {
  AXUIElementRef candidate = (AXUIElementRef)CFRetain(hitElement);
  for (NSUInteger depth = 0; candidate && depth < 12; depth += 1) {
    if (elementSupportsAction(candidate, kAXPressAction)) {
      if (depthOut) *depthOut = depth;
      return candidate;
    }
    CFTypeRef parent = NULL;
    AXError parentError = AXUIElementCopyAttributeValue(candidate, kAXParentAttribute, &parent);
    CFRelease(candidate);
    candidate = parentError == kAXErrorSuccess && parent && CFGetTypeID(parent) == AXUIElementGetTypeID()
      ? (AXUIElementRef)parent : NULL;
    if (!candidate && parent) CFRelease(parent);
  }
  return NULL;
}

@interface WindowBinding : NSObject
@property(nonatomic, retain) NSDictionary *spec;
@property(nonatomic) AXUIElementRef app;
@property(nonatomic) AXUIElementRef window;
@property(nonatomic) Bounds bounds;
@end

@implementation WindowBinding
- (void)dealloc { if (_app) CFRelease(_app); if (_window) CFRelease(_window); [super dealloc]; }
@end

@interface MirrorController : NSObject
@property(nonatomic, retain) NSDictionary *config;
@property(nonatomic, retain) WindowBinding *master;
@property(nonatomic, retain) NSArray<WindowBinding *> *followers;
- (instancetype)initWithConfig:(NSDictionary *)config;
- (void)resolveWindows;
- (void)handleClick:(CGPoint)point;
@end

@implementation MirrorController

- (instancetype)initWithConfig:(NSDictionary *)config {
  if ((self = [super init])) { _config = [config retain]; _followers = @[]; }
  return self;
}

- (void)dealloc { [_config release]; [_master release]; [_followers release]; [super dealloc]; }

- (NSArray<WindowBinding *> *)chromeWindows {
  NSMutableArray *results = [NSMutableArray array];
  for (NSRunningApplication *application in NSWorkspace.sharedWorkspace.runningApplications) {
    if (![[application bundleIdentifier] isEqualToString:@"com.google.Chrome"] && ![[application localizedName] isEqualToString:@"Google Chrome"]) continue;
    AXUIElementRef app = AXUIElementCreateApplication(application.processIdentifier);
    CFTypeRef value = NULL;
    if (AXUIElementCopyAttributeValue(app, kAXWindowsAttribute, &value) == kAXErrorSuccess && CFGetTypeID(value) == CFArrayGetTypeID()) {
      for (CFIndex index = 0; index < CFArrayGetCount((CFArrayRef)value); index += 1) {
        AXUIElementRef window = (AXUIElementRef)CFArrayGetValueAtIndex((CFArrayRef)value, index);
        Bounds bounds; if (!boundsForElement(window, &bounds)) continue;
        WindowBinding *binding = [[[WindowBinding alloc] init] autorelease];
        binding.app = (AXUIElementRef)CFRetain(app); binding.window = (AXUIElementRef)CFRetain(window); binding.bounds = bounds;
        [results addObject:binding];
      }
    }
    if (value) CFRelease(value); CFRelease(app);
  }
  return results;
}

- (WindowBinding *)bindingForSpec:(NSDictionary *)spec excluding:(NSArray<WindowBinding *> *)excluded {
  CGFloat wantedX = [spec[@"x"] doubleValue] + [spec[@"width"] doubleValue] / 2;
  CGFloat wantedY = [spec[@"y"] doubleValue] + [spec[@"height"] doubleValue] / 2;
  WindowBinding *best = nil; CGFloat bestDistance = CGFLOAT_MAX;
  for (WindowBinding *candidate in self.chromeWindows) {
    BOOL used = NO; for (WindowBinding *other in excluded) if (CFEqual(candidate.window, other.window)) { used = YES; break; }
    if (used) continue;
    CGFloat dx = candidate.bounds.x + candidate.bounds.width / 2 - wantedX;
    CGFloat dy = candidate.bounds.y + candidate.bounds.height / 2 - wantedY;
    CGFloat distance = hypot(dx, dy);
    if (distance < bestDistance) { bestDistance = distance; best = candidate; }
  }
  if (!best || bestDistance >= 500) return nil;
  best.spec = spec; return best;
}

- (void)resolveWindows {
  WindowBinding *master = [self bindingForSpec:self.config[@"master"] excluding:@[]];
  if (!master) { emitLog([NSString stringWithFormat:@"Không map được cửa sổ Master %@. Hãy giữ bố cục do Control Panel mở.", self.config[@"master"][@"name"]]); return; }
  NSMutableArray *claimed = [NSMutableArray arrayWithObject:master]; NSMutableArray *followers = [NSMutableArray array];
  for (NSDictionary *spec in self.config[@"followers"]) {
    WindowBinding *follower = [self bindingForSpec:spec excluding:claimed];
    if (!follower) { emitLog([NSString stringWithFormat:@"Không map được follower %@.", spec[@"name"]]); continue; }
    [claimed addObject:follower]; [followers addObject:follower];
  }
  self.master = master; self.followers = followers;
  emitLog([NSString stringWithFormat:@"Đã map %@ → %@ follower.", master.spec[@"name"], @(followers.count)]);
}

- (CGPoint)pointForFollower:(WindowBinding *)follower masterPoint:(CGPoint)point {
  WindowBinding *master = self.master;
  CGFloat xRatio = (point.x - master.bounds.x) / MAX(master.bounds.width, 1);
  CGFloat yRatio = (point.y - master.bounds.y) / MAX(master.bounds.height, 1);
  return CGPointMake(follower.bounds.x + follower.bounds.width * xRatio, follower.bounds.y + follower.bounds.height * yRatio);
}

- (void)handleClick:(CGPoint)point {
  if (!self.master || self.followers.count != [self.config[@"followers"] count]) [self resolveWindows];
  WindowBinding *master = self.master; if (!master || !containsPoint(master.bounds, point)) return;
  AXUIElementRef masterHit = NULL;
  NSString *masterSummary = AXUIElementCopyElementAtPosition(master.app, point.x, point.y, &masterHit) == kAXErrorSuccess && masterHit ? elementSummary(masterHit) : @"không hit-test được";
  if (masterHit) CFRelease(masterHit);
  NSUInteger replayed = 0, direct = 0, parent = 0, noPressTarget = 0, pressFailed = 0;
  NSMutableArray *followerSummaries = [NSMutableArray array];
  for (WindowBinding *follower in self.followers) {
    CGPoint targetPoint = [self pointForFollower:follower masterPoint:point];
    AXUIElementRef hitElement = NULL;
    if (AXUIElementCopyElementAtPosition(follower.app, targetPoint.x, targetPoint.y, &hitElement) != kAXErrorSuccess || !hitElement) { noPressTarget += 1; [followerSummaries addObject:@"không hit-test được"]; continue; }
    [followerSummaries addObject:elementSummary(hitElement)];
    NSUInteger depth = 0;
    AXUIElementRef pressTarget = copyClosestPressableElement(hitElement, &depth);
    CFRelease(hitElement);
    if (!pressTarget) { noPressTarget += 1; continue; }
    if (AXUIElementPerformAction(pressTarget, kAXPressAction) == kAXErrorSuccess) {
      replayed += 1;
      if (depth == 0) direct += 1; else parent += 1;
    } else pressFailed += 1;
    CFRelease(pressTarget);
  }
  if (replayed || noPressTarget || pressFailed) {
    emitLog([NSString stringWithFormat:@"Click AX Master {%@}; follower {%@}.", masterSummary, [followerSummaries componentsJoinedByString:@" | "]]);
    emitLog([NSString stringWithFormat:@"Đã replay Chrome UI click tới %@ follower (trực tiếp %@, parent %@, không có AXPress %@, AXPress lỗi %@).", @(replayed), @(direct), @(parent), @(noPressTarget), @(pressFailed)]);
  }
}
@end

static MirrorController *controller;
static CGEventRef tapCallback(CGEventTapProxy proxy, CGEventType type, CGEventRef event, void *userInfo) {
  if (type == kCGEventLeftMouseDown) [controller handleClick:CGEventGetLocation(event)];
  return event;
}

int main(int argc, const char * argv[]) {
  @autoreleasepool {
    if (argc != 3 || strcmp(argv[1], "--config") != 0) { emitLog(@"Thiếu --config JSON."); return 1; }
    NSData *data = [NSData dataWithBytes:argv[2] length:strlen(argv[2])]; NSError *error = nil;
    NSDictionary *config = [NSJSONSerialization JSONObjectWithData:data options:0 error:&error];
    if (!config || error || !config[@"master"] || !config[@"followers"]) { emitLog(@"--config JSON không hợp lệ."); return 1; }
    NSDictionary *prompt = @{ (__bridge NSString *)kAXTrustedCheckOptionPrompt: @YES };
    if (!AXIsProcessTrustedWithOptions((__bridge CFDictionaryRef)prompt)) {
      emitLog(@"Cần cấp Accessibility cho chrome-ui-sync trong System Settings → Privacy & Security → Accessibility, rồi bấm Chrome UI mirror lại."); return 2;
    }
    controller = [[MirrorController alloc] initWithConfig:config]; [controller resolveWindows];
    CGEventMask mask = CGEventMaskBit(kCGEventLeftMouseDown);
    CFMachPortRef tap = CGEventTapCreate(kCGSessionEventTap, kCGHeadInsertEventTap, kCGEventTapOptionListenOnly, mask, tapCallback, NULL);
    if (!tap) { emitLog(@"Không tạo được global click monitor. macOS có thể yêu cầu thêm quyền Input Monitoring cho chrome-ui-sync."); return 3; }
    CFRunLoopSourceRef source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0);
    CFRunLoopAddSource(CFRunLoopGetCurrent(), source, kCFRunLoopCommonModes); CGEventTapEnable(tap, true);
    emitLog(@"Chrome UI Sync đang chạy: mirror click cho New Tab, toolbar và extension.");
    CFRunLoopRun();
  }
  return 0;
}
