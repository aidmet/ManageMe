# ManageMe privacy policy

**Last updated:** April 18, 2026

This policy describes how the **ManageMe** desktop application (“the app”) handles information when you use it. The app is developed as open-source software; the repository is [github.com/aidmet/ManageMe](https://github.com/aidmet/ManageMe).

## Who we are

**Project:** ManageMe  
**Maintainer / contact:** Aiden Metcalfe — [avaartshop@outlook.com](mailto:avaartshop@outlook.com)

For questions about this policy or your data, email the address above.

## What the app does

ManageMe is an **Electron** desktop app for team and company management features (for example directory, roles, invitations, news, meetings, and messaging). It connects to **Google Firebase** services over the internet when you use accounts and cloud features.

## Information we process (and why)

### Account and authentication (Firebase Authentication)

If you sign up or sign in, Firebase Authentication processes:

- **Email address** and **password** (or related account identifiers Firebase supports), used only to authenticate you and secure your session.

Firebase may also process **technical data** needed to run authentication (for example IP address, device signals) under [Google’s policies](https://policies.google.com/privacy).

### Data you store in the app (Cloud Firestore)

When you use company features, content you and your organization create is stored in **Cloud Firestore** in the **Firebase project baked into the build you run** (for example company profile, members, invitations, posts, meetings, direct messages, notebook content tied to your user id, and audit-style logs). The open-source repository lets developers point the app at **their own** Firebase project; official builds use whatever project the release maintainer configured. This data is **not** copied to a separate “ManageMe server” outside Firebase for normal operation.

**The open-source repository does not receive your Firestore data** unless you separately send it (for example via support email).

### Local device data

The app may keep **local preferences**, **session state**, and similar data on your computer as normal for a desktop app (for example Electron/Chromium storage). Uninstalling the app or clearing app data removes local copies according to your operating system.

### Updates (Electron / GitHub)

In **packaged** builds, the app may check for updates using **update-electron-app**, which contacts **GitHub** and related update infrastructure to see if a newer release exists. That can involve **technical metadata** (for example version, platform) as described in [Electron](https://www.electronjs.org/) and [update-electron-app](https://github.com/electron/update-electron-app) documentation.

### Desktop notifications

If you enable OS notifications for the app, **the operating system** may show alerts (for example for new direct messages). ManageMe does not sell notification content to third parties.

## Third-party services

ManageMe relies on:

| Service        | Provider   | Purpose                                      |
| -------------- | ---------- | -------------------------------------------- |
| Firebase Auth  | Google     | Sign-in and account security                 |
| Cloud Firestore| Google     | Cloud data for app features                  |
| GitHub / update endpoints | Microsoft / GitHub | Application updates (packaged builds) |

Their privacy terms apply to how they process data on their side:

- [Google Privacy Policy](https://policies.google.com/privacy)  
- [Firebase terms](https://firebase.google.com/terms)

## What we do **not** do (by design in this open-source repo)

- We do **not** sell your personal information.  
- We do **not** embed third-party **advertising** or **analytics SDKs** in the open-source tree described in this repository.  
- We do **not** operate a ManageMe-hosted backend separate from **your Firebase project** for normal app use.

If you use a **custom build** or a **fork**, whoever distributes that build is responsible for its behavior.

## Children

ManageMe is not directed at children under 13. Do not use it in a way that collects children’s personal information without appropriate consent and compliance.

## International transfers

Firebase/Google may process data in the United States and other countries where they operate. See Google’s documentation for details.

## Changes

We may update this policy when the app or legal requirements change. The **“Last updated”** date at the top will change when we do. For material changes, we will update this file in the repository when practical.

## Code signing

Release binaries may be **code-signed** so Windows and other platforms can verify publisher identity. Signing for this project may be performed through **SignPath**; the certificate may be issued to **SignPath Foundation**. Signing verifies the **integrity and origin of the build**; it does not change how Firebase processes account or Firestore data described above.

See the [README](README.md) for the current code signing notice.
