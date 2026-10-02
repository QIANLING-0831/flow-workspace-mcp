// Only explicit balance labels count; promotional daily grants are not balances.
export function parseCreditBalance(text: string): number | null {
  const patterns = [
    /(?:remaining\s+(?:AI\s+)?credits|(?:AI\s+)?credits\s+remaining|credit\s+balance)\s*[:：]?\s*([\d,]+)/i,
    /([\d,]+)\s+(?:AI\s+)?credits\s+(?:remaining|left)\b/i,
    /(?:剩余(?:AI\s*)?(?:积分|点数|额度)|(?:积分|点数|额度)余额)\s*[:：]?\s*([\d,]+)/i,
    /^\s*([\d,]+)\s+(?:(?:AI|Google Flow)\s+)?credits\s*$/im,
    /^\s*([\d,]+)\s*(?:个\s*)?Google Flow\s*(?:积分|点数|额度)\s*$/im,
  ];
  const values = patterns.flatMap((pattern) => {
    const match = text.match(pattern);
    return match?.[1] ? [Number(match[1].replaceAll(",", ""))] : [];
  });
  return values.length && values.every((value) => Number.isSafeInteger(value) && value === values[0]) ? values[0]! : null;
}

export function confirmedCreditRejection(text: string, prompt: string): boolean {
  const position = text.lastIndexOf(prompt);
  if (position < 0) return false;
  const response = text.slice(position + prompt.length);
  return /\bFailed\b|失败/.test(response)
    && /reached your credit limit|not enough (?:AI )?credits|insufficient (?:AI )?credits|(?:点数|积分|额度)不足/i.test(response)
    && /(?:won't be|will not be|have not been|not been)\s+charged|不会.*(?:扣|收取)|未.*扣/i.test(response);
}
