import { useRouteError } from "react-router";
import { defineStrings, useLang } from "../lib/i18n";

defineStrings({
  "err.label": ["something broke", "bir şey ters gitti"],
  "err.title": ["This page didn't load.", "Bu sayfa yüklenemedi."],
  "err.body": [
    "Usually Keyarc was just updated while this tab was open. Reloading picks up the new version; nothing on-chain is affected.",
    "Çoğunlukla bu sekme açıkken Keyarc güncellenmiştir. Yenileyince yeni sürüm gelir; zincirdeki hiçbir şey etkilenmez.",
  ],
  "err.reload": ["Reload", "Yenile"],
  "err.home": ["Home", "Ana sayfa"],
});

/** Shown instead of the router's bare error screen when a page fails to render or load. */
export function RouteError() {
  const { t } = useLang();
  console.error(useRouteError());
  return (
    <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 16 }}>
      <div className="card tape no-pin" style={{ maxWidth: 520, width: "100%" }}>
        <div className="label">{t("err.label")}</div>
        <h1 className="title" style={{ marginTop: 6 }}>{t("err.title")}</h1>
        <p className="note" style={{ marginTop: 10 }}>{t("err.body")}</p>
        <div className="row" style={{ marginTop: 18, flexWrap: "wrap" }}>
          <button className="btn red" onClick={() => window.location.reload()}>{t("err.reload")}</button>
          <a className="btn ghost" href="/">{t("err.home")}</a>
        </div>
      </div>
    </div>
  );
}
