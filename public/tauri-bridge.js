(function () {
  const getTauriInvoke = () => {
    if (window.__TAURI__?.core?.invoke) {
      return window.__TAURI__.core.invoke;
    }
    return null;
  };

  const nativeFetch = window.fetch.bind(window);

  function getApiPath(input) {
    const rawUrl = typeof input === "string" ? input : input?.url;
    if (!rawUrl) {
      return null;
    }
    const url = new URL(rawUrl, window.location.href);
    if (!url.pathname.startsWith("/api/")) {
      return null;
    }
    return `${url.pathname}${url.search}`;
  }

  function base64ToBytes(value) {
    const binary = atob(value || "");
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }

  function bytesToBase64(bytes) {
    let binary = "";
    const chunkSize = 0x8000;
    for (let index = 0; index < bytes.length; index += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
    }
    return btoa(binary);
  }

  function responseFromNative(result) {
    const headers = new Headers(result?.headers || {
      "content-type": "application/json; charset=utf-8"
    });
    const body = result?.bodyBase64
      ? base64ToBytes(result.bodyBase64)
      : JSON.stringify(result?.body ?? {});
    return new Response(body, {
      status: Number(result?.status) || 200,
      headers
    });
  }

  window.fetch = async function tauriAwareFetch(input, init = {}) {
    const invoke = getTauriInvoke();
    const path = invoke ? getApiPath(input) : null;
    if (!path) {
      return nativeFetch(input, init);
    }

    let body = null;
    if (init.body instanceof ArrayBuffer) {
      body = { base64: bytesToBase64(new Uint8Array(init.body)) };
    } else if (ArrayBuffer.isView(init.body)) {
      body = { base64: bytesToBase64(new Uint8Array(init.body.buffer, init.body.byteOffset, init.body.byteLength)) };
    } else if (typeof init.body === "string" && init.body.length) {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }

    const result = await invoke("api_request", {
      request: {
        method: init.method || "GET",
        path,
        body
      }
    });
    return responseFromNative(result);
  };
})();
