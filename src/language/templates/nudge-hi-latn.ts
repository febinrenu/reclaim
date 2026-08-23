/**
 * The Hinglish variant bank — SYSTEM_SPEC.md §12's own suggested direction. Same
 * eight-variant, `{{amount}}`/`{{link}}`-slotted structure as nudge-en.ts.
 */
export const WHATSAPP_NUDGE_HI_LATN: readonly string[] = [
  "Hi! Aapka {{amount}} ka payment successful nahi hua. Koi tension nahi — jab chahein retry kar sakte hain, ya yahan reply karein agar help chahiye.",
  "Ek chhota update: {{amount}} ka payment complete nahi hua. Aisa hota hai! Jab convenient ho retry kar lijiye, ya batayein agar kuch aur issue hai.",
  "Bas confirm karna tha — {{amount}} ka payment through nahi hua. Dobara try karna chahenge, ya kuch madad chahiye?",
  "Aapka {{amount}} ka payment bank ne decline kar diya. Same ya alag method se jab marzi retry kar sakte hain.",
  "{{amount}} process nahi ho paya is baar. Card limit ya thoda temporary issue ho sakta hai — retry kar dekhein ya humein batayein.",
  "Heads up: {{amount}} charge successful nahi hua. Retry karne se aksar ho jaata hai — aur agar nahi hota to hum yahin hain.",
  "Aapka recent payment {{amount}} ka successful nahi raha. Jab chahein dobara try kar sakte hain, ya message karein agar check karwana ho.",
  "Ek quick note: {{amount}} ka charge complete nahi hua. Retry karna aksar kaam kar jaata hai — aur help ke liye hum hamesha available hain.",
]

export const PAYMENT_LINK_HI_LATN: readonly string[] = [
  "Hi! Aapka {{amount}} ka payment nahi hua, isliye ek secure link bana diya hai taaki aasani se complete kar sakein: {{link}}",
  "{{amount}} ke payment ki tension mat lijiye — yeh link use karke jab chahein complete kar lijiye: {{link}}",
  "{{amount}} ke liye ek payment link ready hai, bas ek-do taps mein complete ho jaayega: {{link}}",
  "Agar directly retry karna mushkil lage, to {{amount}} ke liye yeh secure link use kar sakte hain: {{link}}",
  "Aapka {{amount}} ka payment ek aur attempt maangta hai — yeh link jaldi kaam aayega: {{link}}",
  "Time bachane ke liye, {{amount}} ka pending payment complete karne ke liye yeh direct link hai: {{link}}",
  "Humne dekha {{amount}} process nahi hua — jab convenient ho is secure link se complete kar lijiye: {{link}}",
  "{{amount}} ka payment jo pehli baar nahi hua, usse complete karne ka aasan tareeka: {{link}}",
]
