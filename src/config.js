// Supabase publishable keys are browser credentials; access is restricted by the database policies.
const defaults = {
  url: "https://ybeinufetluekswsulvj.supabase.co",
  key: "sb_publishable_428OGAyjjm1MO9s9Fgr34g_cXZH1PUy",
};
export function readConfig() {
  try {
    const stored = JSON.parse(
      localStorage.getItem("jeevy-qa-workspace") || "null",
    );
    if (stored?.url && stored?.key) return stored;
  } catch {
    /* Browser storage may be unavailable; use the project defaults. */
  }
  return {
    url: import.meta.env.VITE_SUPABASE_URL || defaults.url,
    key: import.meta.env.VITE_SUPABASE_ANON_KEY || defaults.key,
  };
}
export function saveConfig(config) {
  localStorage.setItem("jeevy-qa-workspace", JSON.stringify(config));
}
