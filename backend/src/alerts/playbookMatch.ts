const RULES: Array<[string, RegExp]> = [
  ['phishing', /phish|credential harvest|malicious (link|url)/i],
  ['malware', /malware|ransom|trojan|virus|backdoor|webshell|c2 beacon/i],
  ['data-exfiltration', /exfil|data (leak|transfer|theft)|large (upload|outbound)/i],
  ['brute-force', /brute.?force|multiple (failed|authentication) (login|failures)|password (spray|guess)/i],
];

export function matchPlaybook(a: { ruleName: string }): string | null {
  for (const [key, re] of RULES) if (re.test(a.ruleName)) return key;
  return null;
}