import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockCheckPermissions, mockIsTauri, mockRequestPermissions, mockScan } = vi.hoisted(() => ({
  mockCheckPermissions: vi.fn(),
  mockIsTauri: vi.fn(),
  mockRequestPermissions: vi.fn(),
  mockScan: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: mockIsTauri,
}));

vi.mock("@tauri-apps/plugin-barcode-scanner", () => ({
  Format: {
    QRCode: "QR_CODE",
  },
  checkPermissions: mockCheckPermissions,
  requestPermissions: mockRequestPermissions,
  scan: mockScan,
}));

import { scanPairingQrCode } from "./pairingQrScanner";

const originalUserAgent = navigator.userAgent;

function setUserAgent(userAgent: string) {
  Object.defineProperty(window.navigator, "userAgent", {
    configurable: true,
    value: userAgent,
  });
}

describe("pairing QR scanner", () => {
  beforeEach(() => {
    mockIsTauri.mockReturnValue(true);
    mockCheckPermissions.mockResolvedValue("granted");
    mockRequestPermissions.mockResolvedValue("granted");
    mockScan.mockReset();
    setUserAgent("Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36");
  });

  afterEach(() => {
    setUserAgent(originalUserAgent);
    vi.resetAllMocks();
  });

  it("scans QR codes with the back camera", async () => {
    mockScan.mockResolvedValue({
      bounds: {},
      content: " tuneforge-sync://pairing-offer ",
      format: "QR_CODE",
    });

    await expect(scanPairingQrCode()).resolves.toBe("tuneforge-sync://pairing-offer");
    expect(mockScan).toHaveBeenCalledWith({
      cameraDirection: "back",
      formats: ["QR_CODE"],
    });
    expect(mockRequestPermissions).not.toHaveBeenCalled();
  });

  it("requests camera permission before scanning", async () => {
    mockCheckPermissions.mockResolvedValue("prompt");
    mockRequestPermissions.mockResolvedValue("granted");
    mockScan.mockResolvedValue({
      bounds: {},
      content: "TFPAIR1.code",
      format: "QR_CODE",
    });

    await expect(scanPairingQrCode()).resolves.toBe("TFPAIR1.code");
    expect(mockRequestPermissions).toHaveBeenCalledTimes(1);
    expect(mockScan).toHaveBeenCalledWith({
      cameraDirection: "back",
      formats: ["QR_CODE"],
    });
  });

  it("rejects denied camera permission before starting the scanner", async () => {
    mockCheckPermissions.mockResolvedValue("prompt");
    mockRequestPermissions.mockResolvedValue("denied");

    await expect(scanPairingQrCode()).rejects.toThrow("Camera permission denied.");
    expect(mockScan).not.toHaveBeenCalled();
  });

  it("rejects non-Tauri runtimes before starting the scanner", async () => {
    mockIsTauri.mockReturnValue(false);

    await expect(scanPairingQrCode()).rejects.toThrow(
      "Pairing QR scanning is only available in the TuneForge Android app.",
    );
    expect(mockScan).not.toHaveBeenCalled();
  });

  it("rejects desktop Tauri runtimes before starting the scanner", async () => {
    setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15");

    await expect(scanPairingQrCode()).rejects.toThrow(
      "Pairing QR scanning is only available in the TuneForge Android app.",
    );
    expect(mockScan).not.toHaveBeenCalled();
  });

  it("rejects iOS Tauri runtimes before starting the scanner", async () => {
    setUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15");

    await expect(scanPairingQrCode()).rejects.toThrow(
      "Pairing QR scanning is only available in the TuneForge Android app.",
    );
    expect(mockScan).not.toHaveBeenCalled();
  });

  it("maps scanner errors to concise messages", async () => {
    mockScan.mockRejectedValue(new Error("camera permission denied"));

    await expect(scanPairingQrCode()).rejects.toThrow("Camera permission denied.");

    mockScan.mockRejectedValue(new Error("No permission to use camera. Did you request it yet?"));

    await expect(scanPairingQrCode()).rejects.toThrow("Camera permission denied.");

    mockScan.mockRejectedValue("plugin barcode-scanner not found");

    await expect(scanPairingQrCode()).rejects.toThrow(
      "Pairing QR scanning is only available in the TuneForge Android app.",
    );
  });
});
