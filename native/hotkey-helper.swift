// dsh-hotkey-helper: the macOS side of the DeepSeek Harness Popout plugin.
//
// Two jobs:
//   1. register one Carbon global hotkey (RegisterEventHotKey, which needs no
//      Accessibility or Input Monitoring permission);
//   2. when given --window-url, host a floating NSPanel with a WKWebView that
//      renders the Harness Web app in "window mode" — a real OS window that
//      opens on the screen with the mouse, can be dragged, and hides itself
//      when it loses focus.
//
// Protocol (line-delimited JSON on stdout/stdin):
//   argv:    --key space --modifiers option [--window-url <url>] [--window-size 780x660]
//   stdout:  {"type":"ready","key":"space","modifiers":["option"]}
//            {"type":"hotkey"}                       (no window configured)
//            {"type":"window-ready"}                 (page finished loading)
//            {"type":"window","visible":true|false}
//            {"type":"error","message":"..."}
//   stdin:   {"cmd":"set","key":"k","modifiers":["cmd","shift"]}
//            {"cmd":"show-window"} {"cmd":"hide-window"} {"cmd":"toggle-window"}
//            {"cmd":"trigger"}
//            {"cmd":"quit"}

import AppKit
import Carbon.HIToolbox
import WebKit

let keyCodes: [String: Int] = [
    "a": kVK_ANSI_A, "b": kVK_ANSI_B, "c": kVK_ANSI_C, "d": kVK_ANSI_D,
    "e": kVK_ANSI_E, "f": kVK_ANSI_F, "g": kVK_ANSI_G, "h": kVK_ANSI_H,
    "i": kVK_ANSI_I, "j": kVK_ANSI_J, "k": kVK_ANSI_K, "l": kVK_ANSI_L,
    "m": kVK_ANSI_M, "n": kVK_ANSI_N, "o": kVK_ANSI_O, "p": kVK_ANSI_P,
    "q": kVK_ANSI_Q, "r": kVK_ANSI_R, "s": kVK_ANSI_S, "t": kVK_ANSI_T,
    "u": kVK_ANSI_U, "v": kVK_ANSI_V, "w": kVK_ANSI_W, "x": kVK_ANSI_X,
    "y": kVK_ANSI_Y, "z": kVK_ANSI_Z,
    "0": kVK_ANSI_0, "1": kVK_ANSI_1, "2": kVK_ANSI_2, "3": kVK_ANSI_3,
    "4": kVK_ANSI_4, "5": kVK_ANSI_5, "6": kVK_ANSI_6, "7": kVK_ANSI_7,
    "8": kVK_ANSI_8, "9": kVK_ANSI_9,
    "space": kVK_Space, "return": kVK_Return, "enter": kVK_Return,
    "tab": kVK_Tab, "escape": kVK_Escape, "esc": kVK_Escape,
    "delete": kVK_Delete, "backspace": kVK_Delete,
    "left": kVK_LeftArrow, "right": kVK_RightArrow,
    "up": kVK_UpArrow, "down": kVK_DownArrow,
    "home": kVK_Home, "end": kVK_End, "pageup": kVK_PageUp, "pagedown": kVK_PageDown,
    "`": kVK_ANSI_Grave, "-": kVK_ANSI_Minus, "=": kVK_ANSI_Equal,
    "[": kVK_ANSI_LeftBracket, "]": kVK_ANSI_RightBracket,
    "\\": kVK_ANSI_Backslash, ";": kVK_ANSI_Semicolon, "'": kVK_ANSI_Quote,
    ",": kVK_ANSI_Comma, ".": kVK_ANSI_Period, "/": kVK_ANSI_Slash,
    "f1": kVK_F1, "f2": kVK_F2, "f3": kVK_F3, "f4": kVK_F4, "f5": kVK_F5,
    "f6": kVK_F6, "f7": kVK_F7, "f8": kVK_F8, "f9": kVK_F9, "f10": kVK_F10,
    "f11": kVK_F11, "f12": kVK_F12,
]

func modifierMask(_ names: [String]) -> UInt32 {
    var mask: UInt32 = 0
    for raw in names {
        switch raw.lowercased() {
        case "option", "alt", "opt": mask |= UInt32(optionKey)
        case "cmd", "command", "meta", "super": mask |= UInt32(cmdKey)
        case "ctrl", "control": mask |= UInt32(controlKey)
        case "shift": mask |= UInt32(shiftKey)
        case "fn": mask |= UInt32(kEventKeyModifierFnMask)
        default: break
        }
    }
    return mask
}

func normalizeModifiers(_ names: [String]) -> [String] {
    var out: [String] = []
    for raw in names {
        switch raw.lowercased() {
        case "option", "alt", "opt": out.append("option")
        case "cmd", "command", "meta", "super": out.append("cmd")
        case "ctrl", "control": out.append("ctrl")
        case "shift": out.append("shift")
        case "fn": out.append("fn")
        default: break
        }
    }
    return out
}

func emit(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object),
          var line = String(data: data, encoding: .utf8) else { return }
    line += "\n"
    FileHandle.standardOutput.write(line.data(using: .utf8)!)
}

// ------------------------------------------------------------ floating window

/// A transparent strip along the top edge that drags the window, so the panel
/// keeps its own header instead of a native title bar.
final class DragStrip: NSView {
    /// Right-hand band left to the web page, so header buttons there (pin,
    /// session menu, sidebar toggle) stay clickable.
    var reservedRight: CGFloat = 0

    override var mouseDownCanMoveWindow: Bool { true }

    override func mouseDown(with event: NSEvent) {
        window?.performDrag(with: event)
    }

    override func hitTest(_ point: NSPoint) -> NSView? {
        let local = superview.map { convert(point, from: $0) } ?? point
        if reservedRight > 0, local.x > bounds.width - reservedRight { return nil }
        return super.hitTest(point)
    }
}

/** A borderless panel refuses key status unless it says otherwise. */
final class KeyablePanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }
}

final class PopoutWindow: NSObject, NSWindowDelegate, WKNavigationDelegate {
    let panel: KeyablePanel
    let web: WKWebView
    private let stripHeight: CGFloat = 22
    private var pinned = false
    private(set) var lastShownAt = Date(timeIntervalSince1970: 0)
    /// Per-display frames, keyed by display id, so a dragged position and a
    /// resized size survive hide/show and application restarts.
    private static let framesKey = "dshp.window.frames"
    private static let sizeKey = "dshp.window.size"
    private static let minimumSize = NSSize(width: 360, height: 320)
    /// The page rewrites its own URL (dropping the token), so reload must use
    /// the original address instead of `web.reload()`.
    private let originalURL: URL

    init(url: URL, size: NSSize) {
        let rect = NSRect(origin: .zero, size: size)
        panel = KeyablePanel(
            contentRect: rect,
            styleMask: [.titled, .fullSizeContentView, .resizable],
            backing: .buffered,
            defer: false)
        panel.isFloatingPanel = true
        // Above the Harness window and other floating utility windows.
        panel.level = .modalPanel
        panel.titleVisibility = .hidden
        panel.titlebarAppearsTransparent = true
        panel.standardWindowButton(.closeButton)?.isHidden = true
        panel.standardWindowButton(.miniaturizeButton)?.isHidden = true
        panel.standardWindowButton(.zoomButton)?.isHidden = true
        panel.minSize = Self.minimumSize
        if let stored = PopoutWindow.storedSize() {
            panel.setContentSize(stored)
        }
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false

        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        // The app may rewrite its URL (stripping the token query), so window
        // mode is signalled by a document-start global instead of a param.
        configuration.userContentController.addUserScript(WKUserScript(
            source: "window.__DSHP_WINDOW__ = true;",
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true))
        web = WKWebView(frame: rect, configuration: configuration)
        // the page paints its own rounded card, so the window must not paint a
        // white sheet behind it
        web.setValue(false, forKey: "drawsBackground")
        web.autoresizingMask = [.width, .height]

        originalURL = url
        super.init()

        let container = NSView(frame: rect)
        container.wantsLayer = true
        container.layer?.cornerRadius = 14
        container.layer?.masksToBounds = true
        container.autoresizingMask = [.width, .height]
        container.addSubview(web)
        let strip = DragStrip(frame: NSRect(
            x: 0, y: rect.height - stripHeight,
            width: rect.width, height: stripHeight))
        strip.autoresizingMask = [.width, .minYMargin]
        // The session header's buttons sit in the top-right band; leave that
        // part of the strip transparent to clicks so they stay responsive.
        strip.reservedRight = 150
        container.addSubview(strip)


        panel.contentView = container
        panel.delegate = self
        web.navigationDelegate = self
        web.load(URLRequest(url: url))
    }

    var isVisible: Bool { panel.isVisible }

    var isPinned: Bool { pinned }

    @objc func togglePin() {
        setPinned(!pinned)
    }

    func setPinned(_ value: Bool) {
        pinned = value
        emit(["type": "pinned", "value": value])
    }

    func show() {
        lastShownAt = Date()
        positionOnMouseScreen()
        NSApp.activate(ignoringOtherApps: true)
        panel.orderFrontRegardless()
        panel.makeKey()
        panel.makeFirstResponder(web)
        // Activation settles a runloop later; re-assert key so a transient
        // resign does not close the panel on the frame it appeared.
        DispatchQueue.main.async { [weak self] in
            guard let self, self.panel.isVisible else { return }
            self.panel.makeKey()
            self.panel.makeFirstResponder(self.web)
        }
        emit(["type": "window", "visible": true])
    }

    func hide(_ reason: String = "command") {
        guard panel.isVisible else { return }
        panel.orderOut(nil)
        emit(["type": "window", "visible": false, "reason": reason])
    }

    func toggle() {
        if panel.isVisible { hide() } else { show() }
    }

    func reload() {
        web.load(URLRequest(url: originalURL))
    }

    /// Used by the plugin's own tests: apply a frame exactly like a user drag.
    func applyFrame(_ rect: NSRect) {
        panel.setFrame(rect, display: true)
        saveGeometry()
    }

    // MARK: geometry persistence

    private static func displayKey(_ screen: NSScreen) -> String {
        let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber
        return number.map { "display-\($0.intValue)" } ?? "display-\(Int(screen.frame.width))x\(Int(screen.frame.height))"
    }

    /// Only origins are per display; the size is shared by every display.
    private static func storedOrigins() -> [String: [Double]] {
        let raw = UserDefaults.standard.dictionary(forKey: framesKey) as? [String: [Double]] ?? [:]
        var origins: [String: [Double]] = [:]
        for (key, value) in raw where value.count >= 2 {
            origins[key] = [value[0], value[1]]
        }
        return origins
    }

    private static func storedSize() -> NSSize? {
        guard let raw = UserDefaults.standard.array(forKey: sizeKey) as? [Double], raw.count == 2 else { return nil }
        let size = NSSize(width: raw[0], height: raw[1])
        guard size.width >= minimumSize.width, size.height >= minimumSize.height else { return nil }
        return size
    }

    private func saveGeometry() {
        let frame = panel.frame
        UserDefaults.standard.set([Double(frame.width), Double(frame.height)], forKey: Self.sizeKey)
        guard let screen = panel.screen ?? NSScreen.main else { return }
        var origins = Self.storedOrigins()
        origins[Self.displayKey(screen)] = [Double(frame.origin.x), Double(frame.origin.y)]
        UserDefaults.standard.set(origins, forKey: Self.framesKey)
    }

    private func screenAtMouse() -> NSScreen? {
        let mouse = NSEvent.mouseLocation
        return NSScreen.screens.first { NSMouseInRect(mouse, $0.frame, false) }
            ?? NSScreen.main
            ?? NSScreen.screens.first
    }

    /// Put the panel on the screen that currently holds the mouse pointer,
    /// restoring the frame the user left there if one is stored.
    private func positionOnMouseScreen() {
        guard let screen = screenAtMouse() else { return }
        let visible = screen.visibleFrame
        let stored = Self.storedSize() ?? panel.frame.size
        let width = min(max(stored.width, Self.minimumSize.width), max(Self.minimumSize.width, visible.width - 24))
        let height = min(max(stored.height, Self.minimumSize.height), max(Self.minimumSize.height, visible.height - 24))
        let size = NSSize(width: width, height: height)

        if let saved = Self.storedOrigins()[Self.displayKey(screen)] {
            var rect = NSRect(x: saved[0], y: saved[1], width: size.width, height: size.height)
            // keep the panel reachable if the display arrangement changed
            rect.origin.x = min(max(rect.origin.x, visible.minX + 8), visible.maxX - rect.width - 8)
            rect.origin.y = min(max(rect.origin.y, visible.minY + 8), visible.maxY - rect.height - 8)
            panel.setFrame(rect, display: true)
            return
        }
        let origin = NSPoint(x: visible.midX - width / 2, y: visible.maxY - height - 70)
        panel.setFrame(NSRect(origin: origin, size: size), display: true)
    }

    // MARK: NSWindowDelegate

    func windowDidMove(_ notification: Notification) {
        saveGeometry()
    }

    func windowDidEndLiveResize(_ notification: Notification) {
        saveGeometry()
    }

    func windowDidResignKey(_ notification: Notification) {
        guard !pinned else { return }
        // Right after showing, activation is still settling: re-check once
        // instead of hiding on that hand-off frame.
        if Date().timeIntervalSince(lastShownAt) < 0.6 {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { [weak self] in
                guard let self, !self.pinned, self.panel.isVisible, !self.panel.isKeyWindow else { return }
                self.hide("resign-key")
            }
            return
        }
        hide("resign-key")
    }

    // MARK: WKNavigationDelegate

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        emit(["type": "window-ready"])
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        emit(["type": "error", "message": "window page failed: \(error.localizedDescription)"])
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        emit(["type": "error", "message": "window page failed to load: \(error.localizedDescription)"])
    }
}

// ----------------------------------------------------------------- hotkey

let hotKeySignature: OSType = 0x44534850 // 'DSHP'
var hotKeyRef: EventHotKeyRef?
var currentKey = "space"
var currentModifiers = ["option"]
var popout: PopoutWindow?

func unregister() {
    if let ref = hotKeyRef {
        UnregisterEventHotKey(ref)
        hotKeyRef = nil
    }
}

/// Returns nil on success, or a human-readable failure reason.
func register(key: String, modifiers: [String]) -> String? {
    guard let code = keyCodes[key.lowercased()] else {
        return "unknown key '\(key)'"
    }
    let mask = modifierMask(modifiers)
    if mask == 0 { return "at least one modifier is required" }
    unregister()
    var ref: EventHotKeyRef?
    let hotKeyID = EventHotKeyID(signature: hotKeySignature, id: 1)
    let status = RegisterEventHotKey(
        UInt32(code), mask, hotKeyID, GetApplicationEventTarget(), 0, &ref)
    if status != noErr {
        return "RegisterEventHotKey failed with status \(status) (the shortcut is probably used by another app)"
    }
    hotKeyRef = ref
    currentKey = key.lowercased()
    currentModifiers = normalizeModifiers(modifiers)
    return nil
}

final class Handler: NSObject {
    @objc func pressed() {
        if let popout {
            popout.toggle()
        } else {
            emit(["type": "hotkey"])
        }
    }
}

let handler = Handler()

func installEventHandler() {
    var spec = EventTypeSpec(
        eventClass: OSType(kEventClassKeyboard),
        eventKind: UInt32(kEventHotKeyPressed))
    InstallEventHandler(
        GetApplicationEventTarget(),
        { _, event, _ -> OSStatus in
            var hotKeyID = EventHotKeyID()
            if let event {
                GetEventParameter(
                    event, EventParamName(kEventParamDirectObject),
                    EventParamType(typeEventHotKeyID), nil,
                    MemoryLayout<EventHotKeyID>.size, nil, &hotKeyID)
            }
            if hotKeyID.signature == hotKeySignature {
                handler.pressed()
            }
            return noErr
        },
        1, &spec, nil, nil)
}

// ---------------------------------------------------------------- args -----

var windowURL: URL?
var windowSize = NSSize(width: 780, height: 680)

func parseArgs() {
    var args = Array(CommandLine.arguments.dropFirst())
    while !args.isEmpty {
        let flag = args.removeFirst()
        func next() -> String? { args.isEmpty ? nil : args.removeFirst() }
        switch flag {
        case "--key": if let value = next() { currentKey = value }
        case "--modifiers":
            if let value = next() {
                currentModifiers = value.split(separator: "+").map(String.init)
            }
        case "--window-url":
            if let value = next(), let url = URL(string: value) { windowURL = url }
        case "--window-size":
            if let value = next() {
                let parts = value.lowercased().split(separator: "x").map(String.init)
                if parts.count == 2, let w = Double(parts[0]), let h = Double(parts[1]) {
                    windowSize = NSSize(width: w, height: h)
                }
            }
        default:
            // Also accept a single combinational argument: "Option+Space".
            if !flag.hasPrefix("-") {
                let parts = flag.split(separator: "+").map(String.init)
                if let last = parts.last, keyCodes[last.lowercased()] != nil {
                    currentKey = last
                    currentModifiers = Array(parts.dropLast())
                }
            }
        }
    }
}

// ---------------------------------------------------------------- stdin ----

final class StdinReader: Thread {
    override func main() {
        while let line = readLine(strippingNewline: true) {
            guard let data = line.data(using: .utf8),
                  let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let cmd = object["cmd"] as? String else { continue }
            switch cmd {
            case "set":
                let key = (object["key"] as? String) ?? currentKey
                let modifiers = (object["modifiers"] as? [String]) ?? currentModifiers
                DispatchQueue.main.async {
                    if let failure = register(key: key, modifiers: modifiers) {
                        emit(["type": "error", "message": failure])
                    } else {
                        emit(["type": "ready", "key": currentKey, "modifiers": currentModifiers])
                    }
                }
            case "show-window":
                DispatchQueue.main.async { popout?.show() }
            case "hide-window":
                DispatchQueue.main.async { popout?.hide() }
            case "toggle-window":
                DispatchQueue.main.async { popout?.toggle() }
            case "window-state":
                DispatchQueue.main.async {
                    let frame = popout?.panel.frame ?? .zero
                    emit([
                        "type": "window-state",
                        "active": NSApp.isActive,
                        "key": popout?.panel.isKeyWindow ?? false,
                        "visible": popout?.panel.isVisible ?? false,
                        "frame": [Double(frame.origin.x), Double(frame.origin.y), Double(frame.width), Double(frame.height)],
                        "resizable": popout?.panel.styleMask.contains(.resizable) ?? false,
                        "titled": popout?.panel.styleMask.contains(.titled) ?? false,
                        "min": popout.map { [Double($0.panel.minSize.width), Double($0.panel.minSize.height)] } ?? [],
                    ])
                }
            case "set-frame":
                let numbers = (object["frame"] as? [Double]) ?? []
                guard numbers.count == 4 else { break }
                DispatchQueue.main.async {
                    popout?.applyFrame(NSRect(x: numbers[0], y: numbers[1], width: numbers[2], height: numbers[3]))
                }
            case "pin":
                let value = (object["value"] as? Bool) ?? true
                DispatchQueue.main.async { popout?.setPinned(value) }
            case "toggle-pin":
                DispatchQueue.main.async { popout?.togglePin() }
            case "reload-window":
                DispatchQueue.main.async { popout?.reload() }
            case "trigger":
                if let popout {
                    DispatchQueue.main.async { popout.toggle() }
                } else {
                    emit(["type": "hotkey"])
                }
            case "quit":
                DispatchQueue.main.async {
                    unregister()
                    NSApp.terminate(nil)
                }
            default:
                break
            }
        }
        DispatchQueue.main.async {
            unregister()
            NSApp.terminate(nil)
        }
    }
}

// ---------------------------------------------------------------- menu -----

/**
 * A bare AppKit process has no main menu, and macOS routes ⌘C/⌘V/⌘X/⌘A/⌘Z
 * through menu items — without them a WKWebView never sees Paste. The items
 * target nil, so they travel the responder chain to the focused web view.
 */
func installEditMenu() {
    let mainMenu = NSMenu()

    let appItem = NSMenuItem()
    let appMenu = NSMenu(title: "Popout")
    let hideItem = NSMenuItem(title: "Hide Panel", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
    appMenu.addItem(hideItem)
    appItem.submenu = appMenu
    mainMenu.addItem(appItem)

    let editItem = NSMenuItem()
    let editMenu = NSMenu(title: "Edit")
    let undoItem = NSMenuItem(title: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
    undoItem.keyEquivalentModifierMask = [.command]
    editMenu.addItem(undoItem)
    let redoItem = NSMenuItem(title: "Redo", action: Selector(("redo:")), keyEquivalent: "z")
    redoItem.keyEquivalentModifierMask = [.command, .shift]
    editMenu.addItem(redoItem)
    editMenu.addItem(NSMenuItem.separator())
    editMenu.addItem(NSMenuItem(title: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x"))
    editMenu.addItem(NSMenuItem(title: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c"))
    let pasteItem = NSMenuItem(title: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
    pasteItem.keyEquivalentModifierMask = [.command]
    editMenu.addItem(pasteItem)
    // ⇧⌘V: paste without the source formatting. `pasteAsPlainText:` is an
    // NSTextView action; WKWebView answers it too, and the responder chain
    // simply disables the item where nothing handles it.
    let plainItem = NSMenuItem(title: "Paste and Match Style", action: #selector(NSTextView.pasteAsPlainText(_:)), keyEquivalent: "v")
    plainItem.keyEquivalentModifierMask = [.command, .shift]
    editMenu.addItem(plainItem)
    editMenu.addItem(NSMenuItem.separator())
    editMenu.addItem(NSMenuItem(title: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a"))
    editItem.submenu = editMenu
    mainMenu.addItem(editItem)

    NSApp.mainMenu = mainMenu
    let titles = mainMenu.items.compactMap { $0.submenu?.title }
    let editItems = mainMenu.items.first(where: { $0.submenu?.title == "Edit" })?
        .submenu?.items.map { item -> String in
            guard item.keyEquivalent != "" else { return item.title }
            var mods = ""
            let mask = item.keyEquivalentModifierMask
            if mask.contains(.control) { mods += "⌃" }
            if mask.contains(.option) { mods += "⌥" }
            if mask.contains(.shift) { mods += "⇧" }
            if mask.contains(.command) { mods += "⌘" }
            return "\(item.title)[\(mods)\(item.keyEquivalent.uppercased())]"
        } ?? []
    emit(["type": "menu", "menus": titles, "edit": editItems])
}

// ---------------------------------------------------------------- main -----

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
installEditMenu()
installEventHandler()
parseArgs()

if let failure = register(key: currentKey, modifiers: currentModifiers) {
    emit(["type": "error", "message": failure])
    exit(2)
}
emit(["type": "ready", "key": currentKey, "modifiers": currentModifiers])

if let url = windowURL {
    // Pre-warm the page while hidden so the first summon is instant.
    let window = PopoutWindow(url: url, size: windowSize)
    popout = window
    emit(["type": "window-preload"])

    // Losing application focus is the reliable "click outside" signal for a
    // non-activating panel; the window delegate alone can miss it.
    NotificationCenter.default.addObserver(
        forName: NSApplication.didResignActiveNotification,
        object: nil,
        queue: .main
    ) { _ in
        guard let window = popout, !window.isPinned else { return }
        if Date().timeIntervalSince(window.lastShownAt) < 0.6 { return }
        window.hide("resign-active")
    }
}

StdinReader().start()
app.run()
