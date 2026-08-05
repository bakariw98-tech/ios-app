# iOS app

SwiftUI. No Xcode project is committed yet — these are the source files, ready to
drop into a new iOS App target (SwiftUI lifecycle, iOS 17+).

```
DelegateApp.swift          App entry; reads BACKEND_URL from the scheme env.
Models/CallSession.swift   Wire types mirroring the backend.
Services/BackendClient.swift  HTTP client. Note: no placeCall method, by design.
Views/CallView.swift       Phone number + call button. Dials via `tel:`.
Views/MergeGuideView.swift The Add Call → Merge Calls instructions.
Views/TranscriptView.swift Live transcript ("chat box").
Views/SummaryView.swift    Post-call summary.
```

## Not yet done

- **No Xcode project / `.xcodeproj`.** Created on a machine with Xcode; the
  container these were written in has no Swift toolchain, so **none of this has
  been compiled.** Expect to fix small things on first build.
- **Navigation between screens is not wired.** `CallView` is the entry point;
  `TranscriptView` and `SummaryView` both take a `callId` that nothing currently
  supplies, because the app has no way to learn the call id yet — see below.
- **The app cannot observe the call.** iOS gives us no way to know the user
  dialled, merged, or hung up. Options, roughly in order of preference:
  1. `CXCallObserver` (CallKit) to detect an outgoing call to our number and its
     end — gives lifecycle but not the Vapi call id.
  2. Have the interview assistant read back a short code the user taps in.
  3. Match on the user's own phone number server-side at call start, if the app
     has it from sign-in.
  None are built. This is the main gap between these files and a working app.

## The merge step

`MergeGuideView` is the most important screen. The app **cannot** perform or
detect the Add Call → Merge Calls sequence — there's no CallKit API for it. See
`docs/technical-decisions.md`, ADR-001, before changing that screen. It is also
the largest delivery risk in v1: native three-way calling is carrier-dependent
and needs a real device matrix before launch.
