import { Link } from "react-router";
import { useLang } from "../lib/i18n";
import { Logo } from "../lib/Logo";

const REPO_URL = "https://github.com/Bekirerdem/keyarc";
const FACTORY_URL = "https://explorer.arc.io/address/0x295F88F793E38eB8be6684b13e02799aADAEd0d9";

/** A slim strip under every app page: who made this, where the contracts are, where the code is. */
export function AppFooter() {
  const { t } = useLang();
  return (
    <footer className="appfoot">
      <Link to="/" className="appfoot-brand"><Logo size={22} /><b>Keyarc</b><span>{t("tagline")}</span></Link>
      <nav aria-label="Keyarc">
        <a href={FACTORY_URL} target="_blank" rel="noopener noreferrer">{t("foot.contracts")} ↗</a>
        <a href={REPO_URL} target="_blank" rel="noopener noreferrer">GitHub ↗</a>
        <span className="live"><i />{t("foot.live")}</span>
      </nav>
    </footer>
  );
}
