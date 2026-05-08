declare const __TUNEFORGE_FRONTEND_GIT_REF__: string | undefined;
declare const __TUNEFORGE_FRONTEND_PACKAGE_VERSION__: string | undefined;

export type VersionInfo = {
  package_version: string;
  git_ref: string;
};

export const FRONTEND_VERSION_INFO: VersionInfo = {
  package_version: normalizeVersionValue(__TUNEFORGE_FRONTEND_PACKAGE_VERSION__),
  git_ref: normalizeVersionValue(__TUNEFORGE_FRONTEND_GIT_REF__),
};

function normalizeVersionValue(value: string | undefined) {
  const normalized = value?.trim();
  return normalized ? normalized : "unknown";
}
