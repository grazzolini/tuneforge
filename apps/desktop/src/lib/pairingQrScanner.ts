import { isTauri } from "@tauri-apps/api/core";
import { Format, checkPermissions, requestPermissions, scan } from "@tauri-apps/plugin-barcode-scanner";

const unsupportedScannerMessage =
  "Pairing QR scanning is only available in the TuneForge Android app.";

export async function scanPairingQrCode(): Promise<string> {
  if (!isPairingQrScannerAvailable()) {
    throw new Error(unsupportedScannerMessage);
  }

  try {
    await ensureCameraPermission();
    const scanned = await scan({
      cameraDirection: "back",
      formats: [Format.QRCode],
    });
    const content = scanned.content.trim();
    if (!content) {
      throw new Error("Scanned QR code was empty.");
    }
    return content;
  } catch (error) {
    throw createPairingQrScanError(error);
  }
}

async function ensureCameraPermission() {
  const currentPermission = await checkPermissions();
  if (currentPermission === "granted") {
    return;
  }

  const requestedPermission = await requestPermissions();
  if (requestedPermission !== "granted") {
    throw new Error("Camera permission denied.");
  }
}

function isPairingQrScannerAvailable() {
  return isTauri() && isMobileUserAgent();
}

function isMobileUserAgent() {
  return typeof navigator !== "undefined" && /\bAndroid\b/i.test(navigator.userAgent);
}

function pairingQrScanErrorMessage(error: unknown) {
  const message = errorMessage(error);
  const normalizedMessage = message.toLowerCase();

  if (normalizedMessage.includes("empty")) {
    return "Scanned QR code was empty.";
  }
  if (
    normalizedMessage.includes("permission") &&
    (normalizedMessage.includes("denied") || normalizedMessage.includes("no permission"))
  ) {
    return "Camera permission denied.";
  }
  if (normalizedMessage.includes("cancel")) {
    return "QR scan canceled.";
  }
  if (
    normalizedMessage.includes("plugin") ||
    normalizedMessage.includes("not found") ||
    normalizedMessage.includes("not implemented") ||
    normalizedMessage.includes("unavailable") ||
    normalizedMessage.includes("unsupported")
  ) {
    return unsupportedScannerMessage;
  }

  return "Could not scan pairing QR code.";
}

function createPairingQrScanError(error: unknown) {
  return Object.assign(new Error(pairingQrScanErrorMessage(error)), { cause: error });
}

function errorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return String(error);
}
