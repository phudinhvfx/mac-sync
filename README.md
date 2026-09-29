# Mac Sync

Local macOS toolkit for synchronizing input from one GPM Login Chrome profile to one or more followers.

## Contents

- `mac-sync.mjs`: CDP-based synchronizer. No npm packages required; use Node.js 22+.
- `gpm-profile-sync-control/`: local browser control panel for opening GPM profiles, collecting their CDP ports, arranging windows, and launching the synchronizer.

## Run the control panel

```bash
node gpm-profile-sync-control/server.mjs
```

Open http://127.0.0.1:8788. The control panel expects `mac-sync.mjs` at this repository's root by default. Set `MAC_SYNC_PATH` when using another location.

## Run the synchronizer directly

```bash
node mac-sync.mjs --master 39207 --targets 39208,39209
```

The browser profiles must have Chrome remote debugging enabled. Press Ctrl+C to stop synchronization; it does not close profiles.

## Wallet extension note

MetaMask and Binance Wallet can be synchronized when opened as a Chrome extension popup or full-page extension URL. Side panels can lose focus and are not a reliable target for this synchronizer. Do not automate wallet unlocks, seed phrases, transaction approvals, or transaction confirmations.
