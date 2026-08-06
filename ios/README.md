# iOS app

SwiftUI. No Xcode project is committed yet — these are the source files, ready to
drop into a new iOS App target (SwiftUI lifecycle, iOS 17+).

Two modes live side by side — see `docs/technical-decisions.md`, ADR-005. **In-
person mode is primary**; phone-call mode is paused, not removed.

```
DelegateApp.swift                    App entry. TabView: BriefView (primary), CallView (paused).

--- In-person mode (primary) ---
Models/RealtimeSession.swift         Wire types for /realtime/session.
Services/RealtimeSessionClient.swift WebRTC connection to OpenAI. Needs the WebRTC package — see below.
Views/BriefView.swift                Type a brief, AI starts talking immediately.

--- Phone-call mode (paused) ---
Models/CallSession.swift             Wire types mirroring the backend's Vapi-call shape.
Services/BackendClient.swift         HTTP client for both modes. No placeCall method, by design.
Views/CallView.swift                 Phone number + call button. Dials via `tel:`.
Views/MergeGuideView.swift           The Add Call → Merge Calls instructions.
Views/TranscriptView.swift           Live transcript ("chat box").
Views/SummaryView.swift              Post-call summary.
```

## Required dependency: WebRTC

In-person mode needs a WebRTC package Apple doesn't ship first-party. Add it in
Xcode: **File → Add Package Dependencies** → `https://github.com/stasel/WebRTC`
(a maintained prebuilt distribution of Google's libwebrtc for iOS/macOS). The
app will not compile without it — `RealtimeSessionClient.swift` imports
`WebRTC` directly.

## Not yet done — in-person mode

- **None of this has been compiled or run.** No Swift toolchain in the
  container this was written in (same caveat as before, now covering more
  surface area). `RealtimeSessionClient.swift`'s REST handshake (mint secret →
  POST offer SDP → apply answer SDP) is written against OpenAI's documented
  flow; the WebRTC library API calls (delegate signatures, exact method names)
  are written from general iOS WebRTC usage and are the most likely thing to
  need small fixes on first real build.
- **Echo cancellation on speakerphone is an open risk, not a solved problem.**
  The AI's voice comes out the speaker; the same phone's mic has to pick up
  the other person without also picking up the AI talking to itself. WebRTC's
  built-in AEC (`.voiceChatSpeaker` audio session mode) is the standard
  mitigation, but multiple developers report it doesn't fully solve this in
  practice on real devices — the model can hear and interrupt itself. This
  needs real-device testing before relying on it. If it's not good enough,
  the fallback is a Bluetooth/wired earpiece (mic and speaker no longer share
  one open acoustic path) — not built, no UI for it yet.
- **Data channel events aren't parsed.** `oai-events` messages (`response.done`,
  `error`, etc.) are currently just printed to the console. A real UI
  probably wants at least `error` surfaced to `RealtimeSessionClient.state`
  and some signal for "the model is currently speaking" vs "listening."
  Structure exists (`RTCDataChannelDelegate`); the parsing doesn't yet.
- **Text-only brief input.** The brief pivot said "types (or speaks)" — only
  typing is built. Voice input for the brief itself (before the live session
  starts) would need `SFSpeechRecognizer` or similar; not started.
- **No reconnect logic.** If the WebRTC connection drops mid-conversation
  (network blip, backgrounding the app), `state` goes to `.failed` and the
  user has to start over. Given this is meant to be used standing at a
  counter mid-transaction, a drop is a real, likely failure mode worth
  handling better — not addressed yet.
- **Backgrounding.** iOS suspends apps aggressively; holding a live WebRTC
  audio session while the phone is, say, put down on a counter (screen off)
  needs the right background audio mode entitlement and hasn't been
  configured (no `Info.plist` is committed at all yet — see below).

## Not yet done — general / phone-call mode

- **No Xcode project / `.xcodeproj`, no `Info.plist`.** Needs microphone usage
  description (`NSMicrophoneUsageDescription`) at minimum for in-person mode
  to even prompt for mic access.
- **Navigation between phone-mode screens is not wired.** `CallView` is
  reachable via the tab bar; `TranscriptView` and `SummaryView` both take a
  `callId` that nothing currently supplies, because the app has no way to
  learn the call id yet.
- **The app cannot observe a phone call.** iOS gives us no way to know the
  user dialled, merged, or hung up. Options, roughly in order of preference:
  1. `CXCallObserver` (CallKit) to detect an outgoing call to our number and
     its end — gives lifecycle but not the Vapi call id.
  2. Have the interview assistant read back a short code the user taps in.
  3. Match on the user's own phone number server-side at call start, if the
     app has it from sign-in.
  None are built.

## The merge step (phone-call mode only)

`MergeGuideView` is the most important screen *in phone mode specifically* —
not relevant to in-person mode at all, which has no merge step. The app
**cannot** perform or detect the Add Call → Merge Calls sequence — there's no
CallKit API for it. See `docs/technical-decisions.md`, ADR-001, before
changing that screen.
