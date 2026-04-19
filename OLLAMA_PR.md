# feat(ui): Implement Local / Cloud Toggle for Ollama Provider

## 📝 Overview
This PR enhances the flexibility of the J.A.R.V.I.S. Ollama integration by adding a dedicated **Local / Cloud toggle** to the Dashboard Settings. This allows users to seamlessly switch between a standard local Ollama instance and a remote/cloud-hosted endpoint without manually retyping common URLs.

## ✨ Key Features
- **Intelligent Connection Toggle**: A new "Connection Type" selector in the Ollama settings card.
- **Context-Aware Defaults**: 
    - **Local Mode**: Instantly defaults the Base URL to `http://localhost:11434`.
    - **Cloud Mode**: Resets the field to a clean `https://` state, optimized for custom server addresses.
- **Editable Persistence**: The URL field remains fully editable regardless of the toggle state, ensuring power users can still define specific ports or subdomains.
- **Enhanced DX**: Updated the state management to detect existing "local" vs "cloud" URLs on load, ensuring the UI accurately reflects current settings.

## 🛠️ Technical Improvements
- **Windows Build Stability**: Added `onnxruntime-web` and `@xenova/transformers` to the base `package.json` to prevent UI build failures in the local environment.
- **Cross-Platform Testing**: Patched `uninstall.test.ts` to use robust path matching (handles Windows `\` vs Linux `/`) and correctly identifies home directories across different OS platforms.
- **Docker Hardening**: Integrated `dos2unix` into the `Dockerfile` to automatically resolve "carriage return" errors (`\r`) caused by Windows line endings in entrypoint scripts.

## 🧪 How to Test
1. Navigate to the **Dashboard > Settings > LLM Configuration**.
2. Expand the **Ollama** section.
3. Click the **Cloud** button; verify the Base URL changes to `https://`.
4. Click the **Local** button; verify the Base URL reverts to `http://localhost:11434`.
5. Edit the URL manually and click **Save Configuration**.
6. Refresh the page and verify that your custom URL is preserved and the correct toggle (Local/Cloud) is highlighted.

---

### 🛡️ Quality Assurance
- [x] All 468 unit tests passed on Windows.
- [x] UI build (`bun run build:ui`) completed with no errors.
- [x] Docker production build verified for startup compatibility.

***

> [!TIP]
> This PR is part of the broader effort to make J.A.R.V.I.S. more portable and easier to configure for non-technical users.
