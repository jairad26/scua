import AppKit
import CoreGraphics
import Foundation

@main
struct AgentCursorTests {
    @MainActor
    static func main() {
        testMotionLifecycle()
        testSmoothArrivalWithoutOvershoot()
        testOverlayLifecycle()
        testApplicationBadgeLifecycle()
        testAgentCursorIsolationAndAppSwitching()
        testOverlayVisibilityContract()
        testAccessibilityCoordinateConversion()
        testCoordinateOriginDisplaySelection()
        testCanvasCoordinateConversion()
    }

    @MainActor
    private static func testMotionLifecycle() {
        let renderer = AgentCursorRenderer()
        renderer.setInitialPosition(CGPoint(x: 100, y: 100))

        expect(!renderer.isAnimating, "renderer should start idle")

        renderer.moveTo(point: CGPoint(x: 500, y: 400))
        expect(renderer.isAnimating, "renderer should become active when motion starts")

        var now: CFTimeInterval = 0
        for _ in 0..<12_000 where renderer.isAnimating {
            now += 1.0 / 120.0
            renderer.tick(now: now)
        }

        expect(!renderer.isAnimating, "renderer should become idle after motion settles")

        renderer.moveTo(point: CGPoint(x: 800, y: 600))
        renderer.tick(now: now + 1.0 / 120.0)
        let stoppedPosition = renderer.position

        renderer.cancelAnimation()
        expect(!renderer.isAnimating, "cancelled motion should become idle")

        renderer.tick(now: now + 1)
        expect(renderer.position == stoppedPosition, "idle ticks should not change the cancelled position")

        renderer.setInitialPosition(CGPoint(x: 100, y: 100))
        renderer.moveTo(point: CGPoint(x: 300, y: 300))
        for _ in 0..<12 {
            now += 1.0 / 120.0
            renderer.tick(now: now)
        }
        let latestTarget = CGPoint(x: 900, y: 700)
        renderer.moveTo(point: latestTarget)
        for _ in 0..<12_000 where renderer.isAnimating {
            now += 1.0 / 120.0
            renderer.tick(now: now)
        }

        expect(distance(renderer.position, latestTarget) < 0.001, "latest target should supersede in-flight motion")
    }

    @MainActor
    private static func testSmoothArrivalWithoutOvershoot() {
        let renderer = AgentCursorRenderer()
        let start = CGPoint(x: 100, y: 100)
        let target = CGPoint(x: 130, y: 112)
        renderer.setInitialPosition(start)
        renderer.moveTo(point: target)

        var now: CFTimeInterval = 10
        var positions: [CGPoint] = []
        for _ in 0..<240 where renderer.isAnimating {
            renderer.tick(now: now)
            positions.append(renderer.position)
            now += 1.0 / 120.0
        }

        expect(!renderer.isAnimating, "a short move should settle in bounded time")
        expect(distance(renderer.position, target) < 0.001, "a short move should land exactly on its target")
        let settled = renderer.position
        for _ in 0..<30 {
            now += 1.0 / 120.0
            renderer.tick(now: now)
            expect(renderer.position == settled, "a settled cursor must not spring past its target")
        }
        let maxFrameDistance = zip(positions, positions.dropFirst())
            .map(distance)
            .max() ?? 0
        expect(maxFrameDistance < 8, "short cursor motion should not jump between frames; got \(maxFrameDistance)")
    }

    @MainActor
    private static func testOverlayLifecycle() {
        let application = NSApplication.shared
        let existingWindows = Set(application.windows.map(ObjectIdentifier.init))
        let scheduler = ManualIdleHideScheduler()
        let cursor = AgentCursor(scheduleIdleHide: scheduler.schedule)

        cursor.animate(to: CGPoint(x: 300, y: 300), above: 0)
        guard let firstWindow = application.windows.first(where: {
            !existingWindows.contains(ObjectIdentifier($0)) && $0.isVisible
        }) else {
            fail("first action should create a visible overlay")
        }

        cursor.animate(to: CGPoint(x: 500, y: 500), above: 0)
        expect(scheduler.count == 2, "each action should replace the idle timeout")

        scheduler.fire(0)
        expect(firstWindow.isVisible, "a stale timeout should not hide the current overlay")
        expect(firstWindow.contentView != nil, "a stale timeout should not release the current view")

        scheduler.fire(1)
        expect(!cursor.isAnimating, "the current timeout should stop rendering")
        expect(!firstWindow.isVisible, "the current timeout should hide the overlay")
        expect(firstWindow.contentView == nil, "the current timeout should release the view tree")

        cursor.animate(to: CGPoint(x: 700, y: 700), above: 0)
        guard let recreatedWindow = application.windows.first(where: {
            !existingWindows.contains(ObjectIdentifier($0)) && $0 !== firstWindow && $0.isVisible
        }) else {
            fail("a later action should recreate the overlay")
        }

        scheduler.fire(2)
        expect(!recreatedWindow.isVisible, "the recreated overlay should retain the idle lifecycle")
        expect(recreatedWindow.contentView == nil, "the recreated overlay should release its view tree")
    }

    @MainActor
    private static func testAgentCursorIsolationAndAppSwitching() {
        AgentCursor.resetAgentCursors()
        let application = NSApplication.shared
        let existingWindows = Set(application.windows.map(ObjectIdentifier.init))

        AgentCursor.animate(agentId: "agent-one", applicationPID: 101, to: CGPoint(x: 300, y: 300), above: 0)
        AgentCursor.animate(agentId: "agent-two", applicationPID: 202, to: CGPoint(x: 700, y: 500), above: 0)

        let resourceWindows = application.windows.filter {
            !existingWindows.contains(ObjectIdentifier($0)) && $0.isVisible
        }
        expect(resourceWindows.count == 2, "independent resources should render independent cursor windows")
        expect(AgentCursor.visibleAgentCount == 2, "independent agents should remain visible concurrently")

        AgentCursor.animate(agentId: "agent-one", applicationPID: 303, to: CGPoint(x: 400, y: 400), above: 0)
        expect(AgentCursor.visibleAgentCount == 2, "one agent switching apps should reuse its cursor")

        AgentCursor.resetAgentCursors()
        expect(AgentCursor.visibleAgentCount == 0, "agent cursor reset should close every overlay")
    }

    @MainActor
    private static func testApplicationBadgeLifecycle() {
        let scheduler = ManualIdleHideScheduler()
        let testIcon = NSImage(size: CGSize(width: 32, height: 32))
        var resolvedPIDs: [pid_t] = []
        let cursor = AgentCursor(
            scheduleIdleHide: scheduler.schedule,
            applicationIconProvider: { pid in
                resolvedPIDs.append(pid)
                return testIcon
            }
        )

        cursor.animate(to: CGPoint(x: 320, y: 240), above: 0, applicationPID: 101)
        expect(cursor.displaysApplicationBadge, "a resolved target app should add its icon badge")
        expect(resolvedPIDs == [101], "the cursor should resolve the target app icon on first use")

        cursor.animate(to: CGPoint(x: 420, y: 340), above: 0, applicationPID: 101)
        expect(resolvedPIDs == [101], "repeated actions for one app should reuse its resolved icon")

        cursor.animate(to: CGPoint(x: 520, y: 440), above: 0, applicationPID: 202)
        expect(resolvedPIDs == [101, 202], "a cursor reassigned to another app should refresh its badge")
        scheduler.fire(2)
    }

    @MainActor
    private static func testOverlayVisibilityContract() {
        let application = NSApplication.shared
        let existingWindows = Set(application.windows.map(ObjectIdentifier.init))
        let scheduler = ManualIdleHideScheduler()
        let cursor = AgentCursor(scheduleIdleHide: scheduler.schedule)
        cursor.animate(to: CGPoint(x: 320, y: 240), above: 0)
        guard let window = application.windows.first(where: {
            !existingWindows.contains(ObjectIdentifier($0)) && $0.isVisible
        }) else { fail("cursor should create an observable overlay window") }
        expect(window.level == .statusBar, "cursor overlay should remain above ordinary app windows")
        expect(
            window.frame.size == CGSize(width: 72, height: 72),
            "cursor should reserve the reference's 72x72 halo footprint; got \(window.frame.size)"
        )
        expect(!window.hasShadow, "cursor should match Codex's shadow-free rendering")
        expect(window.ignoresMouseEvents, "cursor overlay must not intercept user input")
        expect(!window.canBecomeKey && !window.canBecomeMain, "cursor overlay must not take keyboard focus")
        scheduler.fire(0)
    }

    @MainActor
    private static func testCanvasCoordinateConversion() {
        let frame = CGRect(x: 940, y: -1080, width: 1920, height: 1080)
        let topLeft = AgentCursor.canvasPoint(fromCocoaPoint: CGPoint(x: 940, y: 0), in: frame)
        let bottomRight = AgentCursor.canvasPoint(fromCocoaPoint: CGPoint(x: 2860, y: -1080), in: frame)
        expect(topLeft == CGPoint(x: 0, y: 0), "screen top-left should map to canvas top-left")
        expect(bottomRight == CGPoint(x: 1920, y: 1080), "screen bottom-right should map to canvas bottom-right")
    }

    @MainActor
    private static func testAccessibilityCoordinateConversion() {
        let belowMain = AgentCursor.cocoaPoint(
            fromAccessibilityPoint: CGPoint(x: 300, y: 1620),
            mainScreenTop: 1080
        )
        let aboveMain = AgentCursor.cocoaPoint(
            fromAccessibilityPoint: CGPoint(x: 300, y: -500),
            mainScreenTop: 1080
        )
        expect(belowMain == CGPoint(x: 300, y: -540), "AX coordinates should map onto a display below the main display")
        expect(aboveMain == CGPoint(x: 300, y: 1580), "AX coordinates should map onto a display above the main display")
    }

    @MainActor
    private static func testCoordinateOriginDisplaySelection() {
        let frames = [
            CGRect(x: 0, y: 0, width: 1728, height: 1117),
            CGRect(x: -980, y: 1117, width: 1920, height: 1080),
            CGRect(x: 940, y: 1117, width: 1920, height: 1080),
        ]
        let converted = AgentCursor.cocoaPoint(
            fromAccessibilityPoint: CGPoint(x: -500, y: -958),
            screenFrames: frames
        )
        expect(converted == CGPoint(x: -500, y: 2075), "AX conversion must use the coordinate-origin display, not the current key-window display")
    }

    private static func expect(_ condition: @autoclosure () -> Bool, _ message: String) {
        guard condition() else { fail(message) }
    }

    private static func fail(_ message: String) -> Never {
        FileHandle.standardError.write(Data("FAIL: \(message)\n".utf8))
        exit(1)
    }

    private static func distance(_ lhs: CGPoint, _ rhs: CGPoint) -> CGFloat {
        hypot(lhs.x - rhs.x, lhs.y - rhs.y)
    }
}

@MainActor
private final class ManualIdleHideScheduler {
    private var actions: [@MainActor () -> Void] = []

    var count: Int { actions.count }

    func schedule(_ action: @escaping @MainActor () -> Void) -> Task<Void, Never> {
        actions.append(action)
        return Task {}
    }

    func fire(_ index: Int) {
        actions[index]()
    }
}
