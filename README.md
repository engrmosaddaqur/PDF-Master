# PDF MASTER

**Everything PDF. One Powerful App.**

Mobile-first PDF viewer, genuine PDF text & annotation editor, visual page organizer, smart camera document scanner, English & বাংলা OCR, Word-like creator, converter, PDF diff comparison, digital signatures, and AI PDF Assistant.

---

## Download Android APK from GitHub

This repository is pre-configured with **Capacitor Android** and an automated **GitHub Actions** workflow (`.github/workflows/build-apk.yml`) that compiles an installable Android APK (`PDF-Master.apk`) on every push to `main` or `master`.

### 1. Push this project to `engrmosaddaqur/PDF-Master`

Export/download the project files from AI Studio and push them to your GitHub repository:

```bash
git init
git add .
git commit -m "Add PDF MASTER mobile app and Android APK build workflow"
git branch -M main
git remote add origin https://github.com/engrmosaddaqur/PDF-Master.git
git push -u origin main
```

### 2. Wait ~2–3 minutes for GitHub Actions to finish

Go to the **Actions** tab in `engrmosaddaqur/PDF-Master` and watch **Build Android APK** complete.

### 3. Download `PDF-Master.apk`

Once the workflow finishes, download the APK directly from:

- **Direct Latest Release APK URL**:
  `https://github.com/engrmosaddaqur/PDF-Master/releases/latest/download/PDF-Master.apk`
- Or via **Releases** (`https://github.com/engrmosaddaqur/PDF-Master/releases`) -> **PDF-Master.apk**
- Or via **Actions** -> latest run -> **Artifacts** -> `PDF-Master-APK`

> **Note:** On your Android device, tap the downloaded `PDF-Master.apk` and allow **Install unknown apps** for your browser or file manager if prompted.

---

## Local Development (Web & Server)

```bash
npm install
npm run dev
```

Runs the Express + Vite server on `http://localhost:3000`.

### Local Android APK Build (requires JDK 21 & Android Studio / SDK 36)

```bash
npm run build
npx cap add android
npx cap sync android
cd android && ./gradlew assembleDebug
```
