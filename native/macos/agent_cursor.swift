import AppKit

/// One main-run-loop clock updates every visible agent pointer in a single
/// frame. This prevents independent timers from bunching after an AX stall.
@MainActor
private final class AgentCursorFrameClock {
    static let shared = AgentCursorFrameClock()

    private var cursors: [ObjectIdentifier: AgentCursor] = [:]
    private var timer: Timer?

    var activeCursorCount: Int { cursors.count }
    var hasSingleClock: Bool { timer != nil }

    func register(_ cursor: AgentCursor) {
        cursors[ObjectIdentifier(cursor)] = cursor
        guard timer == nil else { return }
        let timer = Timer(
            timeInterval: 1.0 / 60.0,
            target: self,
            selector: #selector(tick(_:)),
            userInfo: nil,
            repeats: true
        )
        self.timer = timer
        RunLoop.main.add(timer, forMode: .common)
    }

    func unregister(_ cursor: AgentCursor) {
        cursors.removeValue(forKey: ObjectIdentifier(cursor))
        stopIfIdle()
    }

    func reset() {
        cursors.removeAll()
        timer?.invalidate()
        timer = nil
    }

    @objc private func tick(_ timer: Timer) {
        let now = ProcessInfo.processInfo.systemUptime
        for cursor in Array(cursors.values) { cursor.tickAnimation(now: now) }
        stopIfIdle()
    }

    private func stopIfIdle() {
        guard cursors.isEmpty else { return }
        timer?.invalidate()
        timer = nil
    }
}

private enum AgentCursorStyle {
    static let windowSize = CGSize(width: 72, height: 72)
    static let glyphOrigin = CGPoint(x: 24, y: 23)
    static let glyphScale: CGFloat = 2
    static let appBadgeFrame = CGRect(x: 42, y: 41, width: 20, height: 20)
    // The left-most point of the pointer is its visual action hotspot.
    static let hotspot = CGPoint(x: 25, y: 29)
}

/// Resolves the target's installed application icon once per app bundle. Cursor
/// animation and drawing only consume the cached NSImage after the first action.
@MainActor
private final class AgentCursorApplicationIconCache {
    static let shared = AgentCursorApplicationIconCache()

    private let icons: NSCache<NSString, NSImage> = {
        let cache = NSCache<NSString, NSImage>()
        cache.countLimit = 128
        return cache
    }()

    func icon(for applicationPID: pid_t) -> NSImage? {
        guard let application = NSRunningApplication(processIdentifier: applicationPID) else { return nil }
        let key = (application.bundleIdentifier ?? application.bundleURL?.path ?? "pid:\(applicationPID)") as NSString
        if let cached = icons.object(forKey: key) { return cached }

        let resolved = application.icon
            ?? application.bundleURL.map { NSWorkspace.shared.icon(forFile: $0.path) }
        guard let resolved, let copied = resolved.copy() as? NSImage else { return nil }
        icons.setObject(copied, forKey: key)
        return copied
    }
}

/// Visual-only cursor; native action delivery remains authoritative.
@MainActor
final class AgentCursor {
    typealias IdleHideScheduler = @MainActor (@escaping @MainActor () -> Void) -> Task<Void, Never>
    typealias ApplicationIconProvider = @MainActor (pid_t) -> NSImage?

    private static var agentCursors: [String: AgentCursor] = [:]

    private var overlay: AgentCursorOverlayWindow?
    private var idleHideTask: Task<Void, Never>?
    private var idleGeneration: UInt = 0
    private var hasInitialPosition = false
    private var motionScreenFrame: CGRect?
    private var applicationPID: pid_t?
    private var applicationIcon: NSImage?
    private let scheduleIdleHide: IdleHideScheduler
    private let applicationIconProvider: ApplicationIconProvider
    private let renderer: AgentCursorRenderer

    init(
        scheduleIdleHide: @escaping IdleHideScheduler,
        applicationIconProvider: ApplicationIconProvider? = nil
    ) {
        self.scheduleIdleHide = scheduleIdleHide
        self.applicationIconProvider = applicationIconProvider ?? AgentCursorApplicationIconCache.shared.icon
        self.renderer = AgentCursorRenderer()
    }

    static func animate(agentId: String, applicationPID: pid_t? = nil, to point: CGPoint, above windowId: UInt32) {
        if agentCursors.count >= 64 {
            agentCursors = agentCursors.filter { $0.value.overlay?.isVisible == true }
        }
        let cursor = agentCursors[agentId] ?? {
            let created = AgentCursor(scheduleIdleHide: scheduleDefaultIdleHide)
            agentCursors[agentId] = created
            return created
        }()
        cursor.animate(to: point, above: windowId, applicationPID: applicationPID)
    }

    static var visibleAgentCount: Int {
        agentCursors.values.filter { $0.overlay?.isVisible == true }.count
    }

    static func resetAgentCursors() {
        for cursor in agentCursors.values {
            cursor.idleHideTask?.cancel()
            AgentCursorFrameClock.shared.unregister(cursor)
            cursor.renderer.cancelAnimation()
            cursor.overlay?.orderOut(nil)
            cursor.overlay?.contentView = nil
            cursor.overlay?.close()
            cursor.overlay = nil
        }
        agentCursors.removeAll()
        AgentCursorFrameClock.shared.reset()
    }

    var isAnimating: Bool {
        renderer.isAnimating
    }

    var displaysApplicationBadge: Bool {
        applicationIcon != nil
    }

    func animate(to point: CGPoint, above windowId: UInt32, applicationPID: pid_t? = nil) {
        idleHideTask?.cancel()
        idleHideTask = nil
        idleGeneration &+= 1

        if let applicationPID, self.applicationPID != applicationPID || applicationIcon == nil {
            self.applicationPID = applicationPID
            applicationIcon = applicationIconProvider(applicationPID)
        }

        let screenPoint = Self.cocoaPoint(fromAccessibilityPoint: point)
        let screen = Self.screen(containing: screenPoint)
        motionScreenFrame = screen.frame
        if !hasInitialPosition {
            let frame = screen.frame
            renderer.setInitialPosition(CGPoint(
                x: min(max(screenPoint.x - 140, frame.minX + 2), frame.maxX - 2),
                y: min(max(screenPoint.y - 140, frame.minY + 2), frame.maxY - 2)
            ))
            hasInitialPosition = true
        }
        let window = ensureWindow(at: renderer.position, on: screen)
        (window.contentView as? AgentCursorGlyphView)?.applicationIcon = applicationIcon
        position(window, at: renderer.position)
        window.alphaValue = 1
        window.contentView?.needsDisplay = true
        window.displayIfNeeded()
        if !window.isVisible { window.orderFrontRegardless() }
        window.orderFrontRegardless()

        renderer.moveTo(point: screenPoint)
        AgentCursorFrameClock.shared.register(self)

        let generation = idleGeneration
        idleHideTask = scheduleIdleHide { [weak self, weak window] in
            guard let self, let window else { return }
            guard generation == idleGeneration, self.overlay === window else { return }

            AgentCursorFrameClock.shared.unregister(self)
            renderer.cancelAnimation()
            window.orderOut(nil)
            window.contentView = nil
            window.close()
            overlay = nil
            idleHideTask = nil
        }
    }

    fileprivate func tickAnimation(now: CFTimeInterval) {
        guard let window = overlay else {
            AgentCursorFrameClock.shared.unregister(self)
            return
        }
        renderer.tick(now: now)
        position(window, at: renderer.position)
        if !renderer.isAnimating {
            AgentCursorFrameClock.shared.unregister(self)
        }
    }

    private func position(_ window: NSWindow, at point: CGPoint) {
        let hotspot = AgentCursorStyle.hotspot
        let boundedPoint: CGPoint
        if let frame = motionScreenFrame {
            boundedPoint = CGPoint(
                x: min(
                    max(point.x, frame.minX + hotspot.x),
                    frame.maxX - (window.frame.width - hotspot.x)
                ),
                y: min(
                    max(point.y, frame.minY + (window.frame.height - hotspot.y)),
                    frame.maxY - hotspot.y
                )
            )
        } else {
            boundedPoint = point
        }
        window.setFrameOrigin(CGPoint(
            x: boundedPoint.x - hotspot.x,
            y: boundedPoint.y - window.frame.height + hotspot.y
        ))
    }

    private static func scheduleDefaultIdleHide(_ hide: @escaping @MainActor () -> Void) -> Task<Void, Never> {
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(20))
            guard !Task.isCancelled else { return }
            hide()
        }
    }

    static func cocoaPoint(fromAccessibilityPoint point: CGPoint, screens: [NSScreen] = NSScreen.screens) -> CGPoint {
        cocoaPoint(fromAccessibilityPoint: point, screenFrames: screens.map(\.frame))
    }

    static func cocoaPoint(fromAccessibilityPoint point: CGPoint, screenFrames: [CGRect]) -> CGPoint {
        let coordinateOriginScreen = screenFrames.first(where: { $0.contains(CGPoint.zero) }) ?? screenFrames.first
        let mainTop = coordinateOriginScreen?.maxY ?? 0
        return cocoaPoint(fromAccessibilityPoint: point, mainScreenTop: mainTop)
    }

    static func cocoaPoint(fromAccessibilityPoint point: CGPoint, mainScreenTop: CGFloat) -> CGPoint {
        CGPoint(x: point.x, y: mainScreenTop - point.y)
    }

    static func canvasPoint(fromCocoaPoint point: CGPoint, in screenFrame: CGRect) -> CGPoint {
        CGPoint(x: point.x - screenFrame.minX, y: screenFrame.maxY - point.y)
    }

    static func screen(containing point: CGPoint, screens: [NSScreen] = NSScreen.screens) -> NSScreen {
        screens.first(where: { $0.frame.contains(point) })
            ?? screens.min(by: { distance(from: point, to: $0.frame) < distance(from: point, to: $1.frame) })
            ?? NSScreen.main!
    }

    private static func distance(from point: CGPoint, to rect: CGRect) -> CGFloat {
        let dx = max(rect.minX - point.x, 0, point.x - rect.maxX)
        let dy = max(rect.minY - point.y, 0, point.y - rect.maxY)
        return hypot(dx, dy)
    }

    private func ensureWindow(at point: CGPoint, on screen: NSScreen) -> AgentCursorOverlayWindow {
        if let overlay { return overlay }
        let size = AgentCursorStyle.windowSize
        let initial = CGPoint(
            x: min(max(point.x - AgentCursorStyle.hotspot.x, screen.frame.minX), screen.frame.maxX - size.width),
            y: min(
                max(point.y - size.height + AgentCursorStyle.hotspot.y, screen.frame.minY),
                screen.frame.maxY - size.height
            )
        )
        let window = AgentCursorOverlayWindow(
            contentRect: CGRect(origin: initial, size: size),
            styleMask: .borderless,
            backing: .buffered,
            defer: false
        )
        window.contentView = AgentCursorGlyphView(applicationIcon: applicationIcon)
        overlay = window
        return window
    }
}

/// Click-through overlay that can never take focus.
private final class AgentCursorOverlayWindow: NSWindow {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }

    override init(contentRect: NSRect, styleMask: NSWindow.StyleMask, backing: NSWindow.BackingStoreType, defer flag: Bool) {
        super.init(contentRect: contentRect, styleMask: styleMask, backing: backing, defer: flag)
        isOpaque = false
        backgroundColor = .clear
        hasShadow = false
        ignoresMouseEvents = true
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        isReleasedWhenClosed = false
        hidesOnDeactivate = false
        level = .statusBar
        sharingType = .readOnly
    }
}

private final class AgentCursorGlyphView: NSView {
    var applicationIcon: NSImage? {
        didSet {
            guard oldValue !== applicationIcon else { return }
            needsDisplay = true
        }
    }

    init(applicationIcon: NSImage? = nil) {
        self.applicationIcon = applicationIcon
        super.init(frame: .zero)
        wantsLayer = true
        layer?.backgroundColor = NSColor.clear.cgColor
    }

    required init?(coder: NSCoder) { nil }
    override var isOpaque: Bool { false }
    override var isFlipped: Bool { true }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        needsDisplay = true
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        let origin = AgentCursorStyle.glyphOrigin
        let scale = AgentCursorStyle.glyphScale
        func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
            CGPoint(x: origin.x + x * scale, y: origin.y + y * scale)
        }

        // The reference uses Codex's rounded pointer silhouette at 2x scale,
        // surrounded by a soft adaptive contrast halo.
        let shape = NSBezierPath()
        shape.move(to: p(0.682965, 3.11905))
        shape.curve(
            to: p(2.9857, 0.861234),
            controlPoint1: p(0.221806, 1.70377),
            controlPoint2: p(1.58003, 0.372346)
        )
        shape.line(to: p(10.7142, 3.55264))
        shape.curve(
            to: p(10.8607, 6.89444),
            controlPoint1: p(12.251, 4.08807),
            controlPoint2: p(12.3448, 6.22659)
        )
        shape.line(to: p(8.00523, 8.17764))
        shape.line(to: p(6.53257, 11.1269))
        shape.curve(
            to: p(3.21226, 10.8788),
            controlPoint1: p(5.81241, 12.5653),
            controlPoint2: p(3.71102, 12.4084)
        )
        shape.line(to: p(0.682965, 3.11905))
        shape.close()

        let isDark = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        let fill = NSColor(srgbRed: 13.0 / 255.0, green: 13.0 / 255.0, blue: 13.0 / 255.0, alpha: 1)
        let outline = NSColor.white
		// Preserve the black fill + white outline the user selected, then adapt
		// only the surrounding contrast halo. A black halo in Dark Mode erased
		// most of the cursor against dark apps and made moving pointers look like
		// intermittent white dashes in recordings.
		let halo = isDark ? NSColor.white : NSColor.black
		// NSShadow flattens to an opaque white blob when the transparent overlay
		// is captured by ScreenCaptureKit. Layered translucent strokes preserve
		// the same soft contrast falloff both live and in recordings.
		for (width, alpha) in [(18.0, 0.035), (12.0, 0.055), (7.0, 0.085)] {
			halo.withAlphaComponent(alpha).setStroke()
			shape.lineWidth = width
			shape.lineJoinStyle = .round
			shape.lineCapStyle = .round
			shape.stroke()
		}
		fill.setFill()
        shape.fill()
        outline.setStroke()
        shape.lineWidth = 2.5
        shape.lineJoinStyle = .round
        shape.lineCapStyle = .round
        shape.stroke()

        drawApplicationBadge()
    }

    private func drawApplicationBadge() {
        guard let applicationIcon else { return }

        // Draw the installed app icon exactly as macOS supplies it. Its native
        // transparency and silhouette are the badge; adding our own white tile
        // made round and dark icons look trapped inside an unrelated box.
        applicationIcon.draw(
            in: AgentCursorStyle.appBadgeFrame,
            from: .zero,
            operation: .sourceOver,
            fraction: 1,
            respectFlipped: true,
            hints: [.interpolation: NSImageInterpolation.high]
        )
    }
}
