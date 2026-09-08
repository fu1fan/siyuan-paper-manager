/** Chinese personal names: preserve explicit boundaries; recognise common compound surnames. */
const COMPOUND_SURNAMES = new Set([
  "欧阳", "歐陽", "司马", "司馬", "上官", "诸葛", "諸葛", "夏侯", "东方", "東方",
  "皇甫", "尉迟", "尉遲", "公孙", "公孫", "慕容", "司徒", "司空", "端木", "令狐",
  "长孙", "長孫", "宇文", "轩辕", "軒轅", "南宫", "南宮", "闻人", "聞人", "独孤", "獨孤",
  "申屠", "仲孙", "仲孫", "太史", "太叔", "澹台", "宗政", "濮阳", "濮陽", "公羊", "左丘",
]);

export function containsHan(value: string): boolean {
  return /\p{Unified_Ideograph}/u.test(value);
}

export function splitChineseName(value: string): { family: string; given: string } | undefined {
  const name = value.trim();
  if (!/^[\p{Unified_Ideograph}·\s]+$/u.test(name)) return undefined;
  const spaced = name.split(/\s+/);
  if (spaced.length === 2) return { family: spaced[0]!, given: spaced[1]! };
  if (spaced.length > 2) return undefined;
  const dot = name.indexOf("·");
  if (dot > 0) return { family: name.slice(0, dot), given: name.slice(dot + 1) };
  // Long strings may be organisations; do not invent a personal-name boundary.
  if ([...name].length > 4) return undefined;
  const length = COMPOUND_SURNAMES.has(name.slice(0, 2)) ? 2 : 1;
  return { family: name.slice(0, length), given: name.slice(length) };
}
