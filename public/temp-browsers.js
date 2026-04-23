(function () {
  const countEl = document.getElementById("temp-browser-count");
  const createBtn = document.getElementById("btn-create-temp-browser");
  const closeBtn = document.getElementById("btn-close-temp-browsers");
  const modalEl = document.getElementById("temp-browser-modal");
  const modalCloseBtn = document.getElementById("temp-browser-modal-close");
  const modalCancelBtn = document.getElementById("btn-cancel-temp-browser");
  const modalSubmitBtn = document.getElementById("btn-submit-temp-browser");
  const toastEl = document.getElementById("temp-browser-toast");
  const toastSpinnerEl = document.getElementById("temp-browser-toast-spinner");
  const toastMessageEl = document.getElementById("temp-browser-toast-message");
  const toastCloseBtn = document.getElementById("temp-browser-toast-close");

  if (!countEl || !createBtn || !closeBtn) {
    return;
  }

  const DOWNLOAD_URL = "https://www.google.com/chrome/";
  const initProxyFieldController =
    typeof window.initProxyFieldController === "function"
      ? window.initProxyFieldController
      : null;
  const initProxyTestController =
    typeof window.initProxyTestController === "function"
      ? window.initProxyTestController
      : null;
  const proxyController = initProxyFieldController
    ? initProxyFieldController({
        combined: "temp-proxy-combined",
        host: "temp-proxy-host",
        port: "temp-proxy-port",
        username: "temp-proxy-username",
        password: "temp-proxy-password",
      })
    : {
        reset() {},
        getValue() {
          return null;
        },
      };
  const proxyTestController = initProxyTestController
    ? initProxyTestController({
        buttonId: "btn-test-temp-proxy",
        resultId: "temp-proxy-test-result",
        proxyController,
        fieldIds: [
          "temp-proxy-combined",
          "temp-proxy-host",
          "temp-proxy-port",
          "temp-proxy-username",
          "temp-proxy-password",
        ],
      })
    : {
        reset() {},
      };

  const state = {
    count: 0,
    creating: false,
    closing: false,
    installed: null, // null=unknown, true/false
  };
  let latestRefreshToken = 0;
  let toastTimer = 0;

  function render() {
    if (state.installed === false) {
      countEl.textContent = "未安装 Chrome ↗";
      countEl.classList.add("vs-count--error");
      countEl.title = "点击打开下载页";
      createBtn.disabled = true;
      createBtn.title = "请先安装 Chrome";
      createBtn.textContent = "创建临时浏览器";
      closeBtn.disabled = true;
      if (modalSubmitBtn) {
        modalSubmitBtn.disabled = true;
        modalSubmitBtn.textContent = "创建";
      }
      return;
    }

    countEl.classList.remove("vs-count--error");
    countEl.title = "";
    countEl.textContent = `临时浏览器：${state.count} 个`;

    createBtn.disabled = state.creating || state.closing;
    createBtn.title = "";
    createBtn.textContent = state.creating ? "创建中..." : "创建临时浏览器";

    closeBtn.disabled = state.count === 0 || state.creating || state.closing;
    closeBtn.textContent = state.closing ? "关闭中..." : "一键关闭临时浏览器";

    if (modalSubmitBtn) {
      modalSubmitBtn.disabled = state.creating || state.closing;
      modalSubmitBtn.textContent = state.creating ? "创建中..." : "创建";
    }
    if (modalCloseBtn) {
      modalCloseBtn.disabled = state.creating;
    }
    if (modalCancelBtn) {
      modalCancelBtn.disabled = state.creating;
    }
  }

  function parseErrorMessage(payload, fallback) {
    if (payload && typeof payload.error === "string" && payload.error.trim()) {
      return payload.error;
    }
    return fallback;
  }

  function clearToastTimer() {
    if (!toastTimer) return;
    clearTimeout(toastTimer);
    toastTimer = 0;
  }

  function hideToast() {
    if (!toastEl) return;
    clearToastTimer();
    toastEl.hidden = true;
    if (toastMessageEl) toastMessageEl.textContent = "";
    else toastEl.textContent = "";
    if (toastSpinnerEl) toastSpinnerEl.hidden = true;
    if (toastCloseBtn) toastCloseBtn.hidden = true;
    toastEl.className = "temp-toast temp-toast--info";
  }

  function showToast(message, tone, options) {
    if (!toastEl) return;
    clearToastTimer();
    toastEl.hidden = false;
    if (toastMessageEl) toastMessageEl.textContent = message;
    else toastEl.textContent = message;
    toastEl.className = `temp-toast temp-toast--${tone}`;
    if (toastSpinnerEl) toastSpinnerEl.hidden = !options.showSpinner;
    if (toastCloseBtn) toastCloseBtn.hidden = false;
    if (!options.sticky) {
      toastTimer = setTimeout(hideToast, 2600);
    }
  }

  function openCreateModal() {
    if (!modalEl || state.creating || state.closing) return;
    proxyController.reset();
    proxyTestController.reset();
    modalEl.classList.remove("hidden");
  }

  function closeCreateModal() {
    if (!modalEl || state.creating) return;
    proxyTestController.reset();
    modalEl.classList.add("hidden");
  }

  async function requestTempBrowsers(path, init, fallbackMessage) {
    const response = await fetch(`/api/temp-browsers${path || ""}`, init);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(parseErrorMessage(payload, fallbackMessage));
    }
    return payload;
  }

  async function refreshSetup() {
    try {
      const payload = await requestTempBrowsers("/setup", { method: "GET" }, "检测 Chrome 失败");
      state.installed = !!payload?.installed;
    } catch {
      state.installed = false;
    }
    render();
    return state.installed;
  }

  async function refreshCount() {
    const refreshToken = ++latestRefreshToken;
    try {
      const payload = await requestTempBrowsers("", { method: "GET" }, "加载临时浏览器数量失败");
      if (refreshToken !== latestRefreshToken) return state.count;
      const count = Number(payload?.count);
      state.count = Number.isFinite(count) && count >= 0 ? count : 0;
      render();
      return state.count;
    } catch (error) {
      if (refreshToken !== latestRefreshToken) return state.count;
      throw error;
    }
  }

  async function handleCreate(proxy) {
    if (state.installed === false) {
      window.open(DOWNLOAD_URL, "_blank");
      return;
    }

    state.creating = true;
    render();
    try {
      await requestTempBrowsers(
        "",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ proxy }),
        },
        "创建临时浏览器失败",
      );
      await refreshCount();
      closeCreateModal();
      showToast("临时浏览器已创建", "success", { sticky: false, showSpinner: false });
    } catch (error) {
      showToast(error?.message || "创建临时浏览器失败", "error", { sticky: false, showSpinner: false });
      await refreshCount().catch(() => {});
    } finally {
      state.creating = false;
      render();
    }
  }

  function buildCloseSummary(payload) {
    const closedCount = Number(payload?.closedCount) || 0;
    const failedIds = Array.isArray(payload?.failedIds) ? payload.failedIds : [];

    if (failedIds.length === 0) {
      if (closedCount > 0) return `已关闭并清理 ${closedCount} 个临时浏览器`;
      return "当前没有可关闭的临时浏览器";
    }
    if (closedCount > 0) {
      return `已关闭并清理 ${closedCount} 个，失败 ${failedIds.length} 个（${failedIds.join(", ")}）`;
    }
    return `关闭失败 ${failedIds.length} 个临时浏览器（${failedIds.join(", ")}）`;
  }

  async function handleCloseAll() {
    const confirmed = window.confirm(
      "将关闭并清理当前项目创建的全部临时浏览器及其 profile/cache 数据，此操作不可恢复。",
    );
    if (!confirmed) return;

    state.closing = true;
    render();
    try {
      const payload = await requestTempBrowsers("", { method: "DELETE" }, "关闭临时浏览器失败");
      showToast(buildCloseSummary(payload), "success", { sticky: false, showSpinner: false });
      await refreshCount();
    } catch (error) {
      showToast(error?.message || "关闭临时浏览器失败", "error", { sticky: false, showSpinner: false });
      await refreshCount().catch(() => {});
    } finally {
      state.closing = false;
      render();
    }
  }

  createBtn.addEventListener("click", () => {
    if (state.installed === false) {
      window.open(DOWNLOAD_URL, "_blank");
      return;
    }
    openCreateModal();
  });

  modalSubmitBtn?.addEventListener("click", () => {
    if (state.creating || state.closing) return;
    try {
      handleCreate(proxyController.getValue());
    } catch (error) {
      showToast(error?.message || "代理配置无效", "error", { sticky: false, showSpinner: false });
    }
  });

  modalCloseBtn?.addEventListener("click", closeCreateModal);
  modalCancelBtn?.addEventListener("click", closeCreateModal);
  modalEl?.addEventListener("click", (event) => {
    if (event.target === modalEl) {
      closeCreateModal();
    }
  });

  closeBtn.addEventListener("click", () => {
    if (!state.creating && !state.closing && state.count > 0) handleCloseAll();
  });

  countEl.addEventListener("click", () => {
    if (state.installed === false) window.open(DOWNLOAD_URL, "_blank");
  });

  toastCloseBtn?.addEventListener("click", hideToast);

  render();
  (async () => {
    const installed = await refreshSetup();
    if (installed) {
      await refreshCount().catch((error) => {
        state.count = 0;
        render();
        showToast(error?.message || "加载临时浏览器数量失败", "error", { sticky: false, showSpinner: false });
      });
    }
  })();

  // Light polling so user-closed windows reflect in count quickly.
  setInterval(() => {
    if (state.installed && !state.creating && !state.closing) {
      refreshCount().catch(() => {});
    }
  }, 4_000);
})();
