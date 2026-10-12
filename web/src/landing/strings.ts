import { defineStrings } from "../lib/i18n";

/** Every user-facing landing string, English + Turkish.
 *  One story: a team bills clients together → today the money lands in one person's wallet →
 *  so the client pays the chest instead → reserve first, the rest by the work, in each member's currency →
 *  an agent collects inside limits the contract sets. */
export const L = defineStrings({
  "l.tagline": ["your team's payment link, on Arc", "ekibin tahsilat linki, Arc'ta"],
  "l.nav.why": ["Why", "Neden"],
  "l.nav.how": ["How", "Nasıl"],
  "l.nav.rules": ["Rules", "Kurallar"],
  "l.nav.open": ["Open the app", "Uygulamayı aç"],

  "l.hero.eyebrow": ["For teams that bill together", "Birlikte iş yapan ekipler için"],
  "l.hero.l1": ["Earn together.", "Birlikte kazan."],
  "l.hero.l2": ["Split by", "Emeğe göre"],
  "l.hero.l3": ["the work.", "bölüş."],
  "l.hero.lede": [
    "Send the client one payment link. The money lands in your team's chest on Arc, a reserve goes aside first, and everyone is paid their share of the work, in the currency they choose.",
    "Müşteriye tek bir ödeme linki gönder. Para Arc'taki ekip kasasına düşer, önce yedek ayrılır, kalanı herkese emeği kadar, seçtiği para biriminde ödenir.",
  ],
  "l.hero.start": ["Send your first invoice", "İlk faturanı gönder"],
  "l.hero.see": ["See how it works", "Nasıl çalıştığını gör"],
  "l.role.frontend": ["frontend", "ön yüz"],
  "l.role.design": ["design", "tasarım"],
  "l.role.contracts": ["contracts", "kontratlar"],
  "l.job.berlin": ["Monthly client · October", "Aylık müşteri · Ekim"],
  "l.job.web": ["Website + upkeep", "Web sitesi + bakım"],
  "l.job.agents": ["Sold to agents · x402", "Ajanlara satış · x402"],
  "l.job.api": ["Invoice parser API", "Fatura okuma API'si"],

  // 2 · the problem: one person collects for everyone
  "l.but.note1": ["“When do I get my share?”", "“Payım ne zaman gelecek?”"],
  "l.but.note2": ["“I asked for euros. You sent USDC.”", "“Ben euro istemiştim, sen USDC göndermişsin.”"],
  "l.but.note3": ["Ran out of cash in August. Nothing set aside.", "Ağustosta nakit bitti. Kenara hiçbir şey ayrılmamıştı."],
  "l.sheet.file": ["Bekir's wallet · 0x39AE…5794", "Bekir'in cüzdanı · 0x39AE…5794"],
  "l.sheet.edited": ["in: 2,000 USDC", "gelen: 2.000 USDC"],
  "l.sheet.owe": ["owed", "borç"],
  "l.sheet.notSent": ["not sent ?", "gönderilmedi ?"],
  "l.sheet.which": ["which network?", "hangi ağ?"],
  "l.sheet.reserve": ["reserve", "yedek"],
  "l.sheet.forgot": ["forgot", "unutuldu"],
  "l.but.title.a": ["But the money lands in ", "Ama para "],
  "l.but.title.em": ["one person's", "tek bir kişinin"],
  "l.but.title.b": [" wallet.", " cüzdanına geliyor."],

  // 3 · the chest
  "l.so.title": ["So the client pays the team's chest.", "Bu yüzden müşteri ekibin kasasına öder."],
  "l.so.invoice": ["Invoice #014 · paid from Base", "Fatura #014 · Base'den ödendi"],
  "l.so.client": ["Monthly client", "Aylık müşteri"],
  "l.so.amount": ["2,000 USDC", "2.000 USDC"],
  "l.rules.senderAmt": ["5,000 USDC", "5.000 USDC"],
  "l.so.matched": ["Matched to", "Eşleştiği iş"],
  "l.so.reserve": ["Reserve · first", "Yedek · önce"],
  "l.so.step1": ["The client pays one link, from any chain", "Müşteri tek linkten öder, hangi zincirden olursa"],
  "l.so.step2": ["Pinned to the job that earned it", "Onu kazandıran işe iğnelenir"],
  "l.so.step3": ["Reserve goes aside first", "Önce yedek ayrılır"],
  "l.so.step4": ["The rest, by the work, in each person's currency", "Kalanı emeğe göre, herkesin kendi para biriminde"],
  "l.so.period": ["Period 10 · October", "10. dönem · Ekim"],
  "l.so.day": ["day 02 · ", "2. gün · "],
  "l.so.flag1.n": ["+2,000", "+2.000"],
  "l.so.flag1": [" paid from Base", " Base'den ödendi"],
  "l.so.flag2": [" to reserve", " yedeğe"],
  "l.so.flag3.n": ["1,800", "1.800"],
  "l.so.flag3": [" split 60 / 40", " 60 / 40 bölündü"],
  "l.so.payA": ["takes USDC · cashes out to lira", "USDC alır · TL'ye çevirir"],
  "l.so.payB": ["converts to EURC", "EURC'ye çevirir"],

  // 4 · rules + the collecting agent
  "l.rules.title": ["Rules change by vote. The agent collects inside them.", "Kurallar oyla değişir. Ajan tahsilatı o kuralların içinde yapar."],
  "l.rules.proposal": ["Proposal 07 · needs 2 of 3", "Öneri 07 · 3 oydan 2'si gerekli"],
  "l.rules.reserve3": ["Keep three months of costs in reserve", "Üç aylık gideri yedekte tut"],
  "l.rules.yes": ["YES", "EVET"],
  "l.rules.unknown": ["Unknown sender", "Tanınmayan gönderen"],
  "l.rules.agent": ["Agent · 03:12", "Ajan · 03:12"],
  "l.rules.agentNote": [
    "5,000 USDC came from an address I don't know. It matches no open invoice and it's above my limit, so I'm holding it and asking you.",
    "Tanımadığım bir adresten 5.000 USDC geldi. Hiçbir açık faturayla eşleşmiyor ve limitimin üstünde. Bekletiyorum, size soruyorum.",
  ],
  "l.rules.held": ["HELD", "BEKLEMEDE"],
  "l.rules.ruler": ["What the agent may move per period", "Ajanın dönem başına yetkisi"],
  "l.rules.limit": ["limit 1,500 USDC · set by vote", "limit 1.500 USDC · oyla belirlendi"],
  "l.rules.log1": ["03:12  held 5,000 USDC · no matching invoice → asked members", "03:12  5.000 USDC bekletildi · eşleşen fatura yok → üyelere soruldu"],
  "l.rules.log2": ["03:14  invoice #015 is 3 days late → reminded the client", "03:14  #015 faturası 3 gün gecikti → müşteriye hatırlatıldı"],
  "l.rules.log3": ["03:20  proposal 07 passed 2/3 · reserve = 3 months", "03:20  öneri 07 kabul 2/3 · yedek = 3 ay"],

  "l.close.period": ["Period 11", "11. dönem"],
  "l.close.opens": ["opens today", "bugün açılıyor"],
  "l.close.label": ["Month end · everyone paid · board cleared", "Ay sonu · herkese ödendi · pano temizlendi"],
  "l.close.title": ["Paid for the work you did. Rules nobody can bend.", "Emeğin kadar pay. Kimsenin bozamadığı kurallar."],
  "l.close.body": [
    "Add your team, write down the shares, send the client a link. The chest and its agent take it from there.",
    "Ekibini ekle, payları yaz, müşteriye linki gönder. Gerisini kasa ve ajanı halleder.",
  ],
  "l.close.contract": ["Read the contract", "Kontratı incele"],
  "l.foot.a": ["Built on Arc · settled in USDC", "Arc üzerinde · USDC ile ödenir"],
  "l.foot.b": ["Keyarc · live on Arc mainnet", "Keyarc · Arc mainnet'te canlı"],
});
