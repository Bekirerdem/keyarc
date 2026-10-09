import { defineStrings } from "../lib/i18n";

/** Copy for the keystone-arch landing. The story is the approved one; the arch is how it is told. */
export const A = defineStrings({
  "a.tag": ["shared treasury on Arc", "Arc'ta ortak kasa"],
  "a.open": ["Open the app", "Uygulamayı aç"],
  "a.scroll": ["Scroll", "Kaydır"],

  "a.hero.eyebrow": ["For teams that earn together", "Birlikte kazanan ekipler için"],
  "a.hero.l1": ["Three people finished a job.", "Üç kişi bir iş bitirdi."],
  "a.hero.l2": ["The money arrived.", "Para geldi."],
  "a.hero.l3": ["Now the hard part starts.", "Asıl zor kısım şimdi başlıyor."],

  "a.s1.k": ["01 · the reserve", "01 · yedek"],
  "a.s1.t": ["First, the foundation.", "Önce temel atılır."],
  "a.s1.b": [
    "A share of every payment goes to the reserve before anyone is paid. It leaves only by vote.",
    "Her ödemenin bir payı, kimse para almadan önce yedeğe ayrılır. Oradan ancak oylamayla çıkar.",
  ],
  "a.s2.k": ["02 · the shares", "02 · paylar"],
  "a.s2.t": ["Then everyone sets their own stone.", "Sonra herkes kendi taşını koyar."],
  "a.s2.b": [
    "Who did the work and how much it is worth is cut into the invoice before the money arrives. Nothing left to argue about later.",
    "İşi kim yaptı, payı ne kadar: para gelmeden faturaya kazınır. Sonradan tartışacak bir şey kalmaz.",
  ],
  "a.s3.k": ["03 · the rules", "03 · kurallar"],
  "a.s3.t.a": ["The keystone is", "Kilit taşı"],
  "a.s3.t.b": ["the rules.", "kurallardır."],
  "a.s3.b": [
    "Nobody can pull it out alone: not the founder, not a member, not the agent. Changing it takes the team's vote.",
    "Kimse onu tek başına çekip alamaz: ne kurucu, ne bir üye, ne de ajan. Değişmesi için ekibin oyu gerekir.",
  ],

  // cut into the stones
  "a.st.reserve": ["RESERVE", "YEDEK"],
  "a.st.reserveSub": ["10% of every payment", "her ödemenin %10'u"],
  "a.st.key": ["RULES", "KURALLAR"],
  "a.st.keySub": ["changed only by vote", "yalnızca oyla değişir"],
  "a.st.frontend": ["frontend · 45%", "ön yüz · %45"],
  "a.st.design": ["design · 30%", "tasarım · %30"],
  "a.st.contracts": ["contracts · 25%", "kontratlar · %25"],
  "a.st.job1": ["#09 · LOGO", "#09 · LOGO"],
  "a.st.job2": ["#11 · AUDIT", "#11 · DENETİM"],
  "a.st.job3": ["#12 · WEB", "#12 · WEB"],
});
