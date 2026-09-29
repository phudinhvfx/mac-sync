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
@property(nonatomic) NSTimeInterval transientUntil;
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

- (void)handleClick:(CGPoint)point {
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INTERACTIVE, 0), ^{
    if (!self.master || self.followers.count != [self.config[@"followers"] count]) [self resolveWindows];
    WindowBinding *master = self.master; if (!master || !containsPoint(master.bounds, point)) return;
    BOOL inChromeTopBand = point.y <= master.bounds.y + MIN(180, master.bounds.height * 0.28);
    if (!inChromeTopBand && NSDate.timeIntervalSinceReferenceDate > self.transientUntil) return;

    CGFloat xRatio = (point.x - master.bounds.x) / MAX(master.bounds.width, 1);
    CGFloat yRatio = (point.y - master.bounds.y) / MAX(master.bounds.height, 1);
    NSUInteger replayed = 0;
    for (WindowBinding *follower in self.followers) {
      CGPoint targetPoint = CGPointMake(follower.bounds.x + follower.bounds.width * xRatio, follower.bounds.y + follower.bounds.height * yRatio);
      AXUIElementRef target = NULL;
      if (AXUIElementCopyElementAtPosition(follower.app, targetPoint.x, targetPoint.y, &target) != kAXErrorSuccess || !target) continue;
      if (AXUIElementPerformAction(target, kAXPressAction) == kAXErrorSuccess) replayed += 1;
      CFRelease(target);
    }
    if (replayed) { self.transientUntil = NSDate.timeIntervalSinceReferenceDate + 6; emitLog([NSString stringWithFormat:@"Đã replay Chrome UI tới %@ follower.", @(replayed)]); }
  });
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
    emitLog(@"Chrome UI mirror đang chạy: tab, toolbar, extension, menu và side-panel toggle.");
    CFRunLoopRun();
  }
  return 0;
}
