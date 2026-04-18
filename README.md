# ManageMe

**ManageMe** is an open-source desktop app (Electron) for small teams: directory, roles, invitations, company news, meetings, direct messages, holiday workflows, and more—backed by **Firebase** (Authentication + Firestore).

- **License:** MIT  
- **Repository:** [github.com/aidmet/ManageMe](https://github.com/aidmet/ManageMe)  
- **Releases / downloads:** [GitHub Releases](https://github.com/aidmet/ManageMe/releases)  
- **Privacy:** [PRIVACY.md](PRIVACY.md)

## Code signing

Free code signing is provided by [SignPath.io](https://about.signpath.io); the code signing certificate is issued to [SignPath Foundation](https://signpath.org).

### Team roles (signing & governance)

Per [SignPath Foundation conditions](https://signpath.org/terms.html), this project maintains these roles:

- **Authors (committers):** people who may push or merge to [aidmet/ManageMe](https://github.com/aidmet/ManageMe) (see [contributors](https://github.com/aidmet/ManageMe/graphs/contributors); use GitHub **Teams** under your org if you split roles that way).
- **Reviewers:** external contributions are expected to go through **pull request review** before merge.
- **Approvers:** maintainers who approve **release** builds for code signing (typically the same people responsible for tags/releases).

If you are the sole maintainer, you act as committer, reviewer, and release approver—update this section if you add collaborators or GitHub Teams.

## Development

Requirements: **Node.js** (LTS recommended), npm.

```bash
npm install
npm start
```

Other scripts:

- `npm run package` — package the app locally  
- `npm run make` — create installers (e.g. Squirrel on Windows)  
- `npm run lint` — run ESLint  

Configure Firebase in `src/firebase.ts` for your own project when developing.

## Security

Report security issues responsibly to the maintainer (see [PRIVACY.md](PRIVACY.md) for contact).
