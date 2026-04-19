# feat(ui): Add NVIDIA NIM Settings Card

## 📝 Overview
This PR completes the integration of **NVIDIA NIM (Inference Microservices)** into the J.A.R.V.I.S. ecosystem. While the backend logic was established in previous commits, this update surfaces the configuration via a dedicated settings card in the Dashboard UI.

## ✨ Key Features
- **Dedicated NIM Provider Card**: A new, sleek settings section for NVIDIA NIM in the LLM Configuration panel.
- **Pre-configured Model Dropdown**: Support for high-performance NVIDIA-optimized models, including:
    - `usdcode` (Specialized for code generation)
    - `mistral-nemo-minitron-8b-base` (Highly efficient assistant model)
    - `gemma-2-2b-it` (Lightweight reasoning)
- **Secure Key Management**: Integration with the standard J.A.R.V.I.S. credential vault for API key storage.
- **Connection Testing**: Full support for the "Test Connection" feature to verify API keys and network access directly from the UI.

## 🛠️ Technical Improvements
- **Backend Refinement**: Synchronized the frontend payloads with the existing `NvidiaProvider` logic to ensure seamless configuration persistence.
- **Build Hardening**: Included critical fixes for `onnxruntime-web` assets and `transformers.js` dependencies to ensure the Dashboard builds correctly on Windows environments.
- **Docker Stability**: Applied `dos2unix` patches to the `Dockerfile` to ensure the container remains functional across different host operating systems.

## 🧪 How to Test
1. Navigate to the **Dashboard > Settings > LLM Configuration**.
2. Locate the new **NVIDIA NIM** card.
3. Input your `NVIDIA_API_KEY`.
4. Select `mistral-nemo-minitron-8b-base` from the dropdown.
5. Click **Test Connection**; verify the "Connected" status message appears.
6. Click **Save Configuration** and restart the daemon to verify the provider is active.

---

### 🛡️ Quality Assurance
- [x] All unit tests passed (468/468).
- [x] UI production build verified.
- [x] Docker image built and tested for startup stability on Windows.

***

> [!IMPORTANT]
> This completes the Task 1 requirement to bring free, high-performance inference from NVIDIA NIM to the J.A.R.V.I.S. platform.
