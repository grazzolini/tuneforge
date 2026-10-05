import { useQuery } from "@tanstack/react-query";
import { invoke, isTauri } from "@tauri-apps/api/core";

export type PackageIdentity = {
  packageId: string;
  isTestPackage: boolean;
};

export function usePackageIdentity(): PackageIdentity | null {
  const identity = useQuery({
    queryKey: ["installed-package-identity"],
    queryFn: () => isTauri() ? invoke<PackageIdentity | null>("get_package_identity") : null,
    staleTime: Infinity,
    retry: false,
  });
  return identity.data ?? null;
}
