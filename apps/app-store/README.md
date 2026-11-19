# App store

Parker's own Android apps, as an F-Droid repository. A push to main that raises an app's
`versionCode` reaches his phone with nobody touching the phone.

```text
push to main -> GitHub Actions builds and signs the APK -> GitHub release
             -> sync.sh on the lab server (every 5 minutes) -> fdroid update
             -> the F-Droid client on the phone installs it in the background
```

- Repository: `https://fdroid.petalcat.dev/store/repo`, behind a login.
- Index key fingerprint (SHA-256): `13c63e0bdf3dca58c658a0e88a663540a0a2d263a6bd488af35d9f4d22e5a6e3`
- The lab's older public repository, `https://fdroid.petalcat.dev/repo`, is served by the same
  container and is not managed here beyond that.
- The app hub, `https://app.petalcat.dev`, is served by the same container. It lists every app in
  either repository with a direct APK, an Obtainium link and an add-to-F-Droid link.

## The hub

`hub/hub.sh` builds the hub from the two `index-v1.json` files and runs at the end of every
`sync.sh` run, so a hand-published change to the public repository shows up within five minutes.
Nothing is copied: `/apps/<slug>/download/<slug>.apk` is a link to the current APK in the public
repository, so an APK exists once and has one URL for Obtainium.

- `hub/hub.json` maps each slug to a package and a repository, and holds each repository's index
  key fingerprint. It is the only place an app is added to the hub.
- `/api/apps` and `/api/apps/<slug>` return the same JSON the old app registry did, from the
  indexes. `etag` and `color` are gone.
- An app in the store repository gets an add-to-F-Droid link only. Its APKs stay behind the login
  and the page never carries it.

## On the phone

1. Install [F-Droid](https://f-droid.org). Droid-ify also works.
2. Open the add-repository link, which carries the login and the fingerprint:
   `https://USER:PASSWORD@fdroid.petalcat.dev/store/repo?fingerprint=13c63e0bdf3dca58c658a0e88a663540a0a2d263a6bd488af35d9f4d22e5a6e3`
3. Install or update each app once from F-Droid and allow it to install apps when Android asks.

Android 12 and later let a store update an app silently only when that store did the last install.
A copy that was sideloaded keeps its data, because the signing key is the same, but its first
update through F-Droid asks for one confirmation. After that, updates need nothing.

## Access

The repository is reachable from anywhere, so the phone updates on cellular. F-Droid clients cannot
sign in through Authentik or send Cloudflare Access headers. They can send HTTP basic auth, so that
is what guards `/store/`.

- Basic auth keeps the index and the APKs away from anyone without the login, and the login can be
  rotated by replacing `htpasswd` and re-adding the repository on the phone.
- An unguessable path would be simpler on the phone, but the path shows up in logs and cannot be
  told apart from the address, so it was not used.
- Neither protects against a tampered download. The signed index does: the client pins the
  fingerprint above, and the server holds that key, not GitHub.

## Adding an app

1. Have CI publish a release whose tag starts with a prefix of its own and whose asset is named
   `<package>_<versionCode>.apk`. `.github/workflows/janet-call-android-release.yml` is the example.
2. Add `metadata/<package>.yml` with `AllowedAPKSigningKeys` set to the SHA-256 of the app's signing
   certificate. `sync.sh` refuses an APK signed by any other key.
3. Add a line to `apps.tsv`.
4. Add the app to `hub/hub.json`.

An app in the public repository needs only step 4 and a hand-published APK.

An app's signing key must never change, or installed copies stop updating.

## The server

State lives outside the checkout, in `APP_STORE_DIR` (`/home/docker/app-store`):

| Path                         | What                                                             |
| ---------------------------- | ---------------------------------------------------------------- |
| `config.yml`, `keystore.p12` | fdroidserver config and the index signing key. Mode 600.         |
| `htpasswd`                   | The basic auth login. Mode 644, and present before the first up. |
| `repo/`, `archive/`          | The served repository and the versions fdroidserver retired.     |
| `hub/`                       | The generated hub page, API and download links. Written by `hub/hub.sh`. |

The keystore, its password, the fingerprint and the login are in the vault as `appstore-*`.

Deploy from a checkout of main:

```sh
APP_STORE_DIR=/home/docker/app-store apps/app-store/hub/hub.sh
docker compose -f apps/app-store/compose.yaml up -d
install -m 644 apps/app-store/systemd/app-store-sync.* ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now app-store-sync.timer
```

The timer runs `sync.sh` from `/home/docker/releases/app-store/current`, a symlink to that checkout.
It needs `fdroid` (fdroidserver 2.4), `apksigner`, `curl` and `jq`, and the user needs
`loginctl enable-linger` for the timer to run while nobody is logged in.

## iPad

There is no iOS app in this repository yet. When there is one, it ships through TestFlight, which
has the same shape: CI on main uploads a build and the TestFlight app on the iPad installs it with
Automatic Updates on. It costs nothing beyond the Apple Developer membership.

What only the account holder can do, once:

1. In [App Store Connect](https://appstoreconnect.apple.com), open Users and Access, then
   Integrations, then App Store Connect API, then Team Keys. Generate a key named `monorepo-ci`
   with the App Manager role. Download the `.p8` file, which is offered once, and note the Key ID
   and the Issuer ID shown on that page.
2. Note the Team ID from [Membership details](https://developer.apple.com/account#MembershipDetailsCard).
3. In App Store Connect, open Apps and add a new iOS app with the app's bundle ID. Apple does not
   let an API key create the app record.
4. In the app's TestFlight tab, add yourself to an internal testing group. Internal testers get
   builds without beta review.
5. On the iPad, install TestFlight, accept the invitation and turn on Automatic Updates for the app.

The `.p8`, Key ID, Issuer ID and Team ID then go into a GitHub environment that only deploys from
main, like `android-release`. The workflow runs on a macOS runner, signs with cloud-managed
certificates through the API key (`xcodebuild -allowProvisioningUpdates` with the
`-authenticationKey*` flags), sets the build number from the run number and uploads the archive.

- A TestFlight build expires after 90 days, so the workflow also needs a monthly schedule.
- Set `ITSAppUsesNonExemptEncryption` to `false` in `Info.plist` when that is true, or every build
  waits for an export compliance answer.
