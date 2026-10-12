const normalize = (value: string) => value.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('pt-BR');

export function matchesSearch(text: string, query: string): boolean {
  const content = normalize(text);
  return normalize(query).trim().split(/\s+/).every(word => content.includes(word));
}
