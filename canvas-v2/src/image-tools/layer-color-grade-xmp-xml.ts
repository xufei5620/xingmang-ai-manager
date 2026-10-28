export const maximumColorGradeXmpBytes = 64 * 1024
export const xmpNamespaces = { x: 'adobe:ns:meta/', rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#', crs: 'http://ns.adobe.com/camera-raw-settings/1.0/', xml: 'http://www.w3.org/XML/1998/namespace' } as const

export interface ColorGradeXmlAttribute { uri: string; local: string; value: string }
export interface ColorGradeXmlElement { uri: string; local: string; attributes: ColorGradeXmlAttribute[]; children: ColorGradeXmlElement[]; text: string }

function invalid(message: string): never { throw new Error(`XMP ${message}；当前调整未改变`) }
function validCharacter(value: number): boolean { return value === 9 || value === 10 || value === 13 || value >= 0x20 && value <= 0xd7ff || value >= 0xe000 && value <= 0xfffd || value >= 0x10000 && value <= 0x10ffff }
function decode(value: string): string {
  return value.replace(/&([^;\s<&]{1,32});|&/g, (whole, entity: string | undefined) => {
    const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
    if (entity && Object.hasOwn(named, entity)) return named[entity]
    if (entity && /^#(?:[0-9]{1,8}|x[0-9a-fA-F]{1,6})$/.test(entity)) {
      const number = entity.startsWith('#x') ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10)
      if (validCharacter(number)) return String.fromCodePoint(number)
    }
    return invalid(`含未知或无效实体 ${whole.slice(0, 36)}`)
  })
}

/** This bounded reader has no DOM, resolver, DTD, XInclude or network facility. */
export function parseColorGradeXmpXml(input: string): ColorGradeXmlElement {
  if (new TextEncoder().encode(input).length > maximumColorGradeXmpBytes) invalid('文件不能超过 64 KiB')
  if ([...input].some((character) => !validCharacter(character.codePointAt(0)!))) invalid('含无效 XML 字符')
  const text = input.replace(/^\uFEFF/, '')
  let offset = 0, count = 0, attributesCount = 0, declaration = false
  let root: ColorGradeXmlElement | null = null
  const stack: { name: string; element: ColorGradeXmlElement; namespaces: Map<string, string> }[] = []
  function whitespace() { while (offset < text.length && /[\t\n\r ]/.test(text[offset])) offset++ }
  function name() {
    const match = /^[A-Za-z_][A-Za-z0-9_.-]*(?::[A-Za-z_][A-Za-z0-9_.-]*)?/.exec(text.slice(offset))
    if (!match || match[0].length > 128) invalid('标签或属性名无效')
    offset += match[0].length
    return match[0]
  }
  function resolved(qualified: string, namespaces: Map<string, string>, attribute = false) {
    const parts = qualified.split(':')
    if (parts.length === 1) return { uri: attribute ? '' : namespaces.get('') ?? '', local: parts[0] }
    const uri = namespaces.get(parts[0])
    if (!uri) invalid(`命名空间前缀 ${parts[0]} 未声明`)
    return { uri, local: parts[1] }
  }
  function body(value: string) {
    if (stack.length) stack[stack.length - 1].element.text += value
    else if (value.trim()) invalid('根标签外含多余内容')
  }
  while (offset < text.length) {
    if (text.startsWith('<!--', offset)) {
      const end = text.indexOf('-->', offset + 4)
      if (end < 0 || text.slice(offset + 4, end).includes('--')) invalid('注释未正确结束')
      offset = end + 3; continue
    }
    if (text.startsWith('<?', offset)) {
      const end = text.indexOf('?>', offset + 2)
      if (end < 0) invalid('处理指令未结束')
      const instruction = text.slice(offset + 2, end)
      if (/^xml\s/.test(instruction)) {
        if (declaration || root || stack.length || !/^xml\s+version\s*=\s*(['"])1\.0\1(?:\s+encoding\s*=\s*(['"])UTF-8\2)?(?:\s+standalone\s*=\s*(['"])(?:yes|no)\3)?\s*$/i.test(instruction)) invalid('XML 声明不受支持')
        declaration = true
      } else {
        if (!/^xpacket\s+(?:(?:begin|id|end)\s*=\s*(?:"[^"<>]*"|'[^'<>]*')\s*)+$/.test(instruction) || stack.length) invalid('不支持外部处理指令')
        const keys = [...instruction.matchAll(/\b(begin|id|end)\s*=/g)].map((entry) => entry[1])
        if (new Set(keys).size !== keys.length) invalid('xpacket 属性重复')
      }
      offset = end + 2; continue
    }
    if (text.startsWith('<![CDATA[', offset)) {
      if (!stack.length) invalid('CDATA 必须位于根标签内')
      const end = text.indexOf(']]>', offset + 9)
      if (end < 0) invalid('CDATA 未正确结束')
      body(text.slice(offset + 9, end)); offset = end + 3; continue
    }
    if (text.startsWith('<!', offset)) invalid('不允许 DOCTYPE、ENTITY 或其他声明')
    if (text.startsWith('</', offset)) {
      offset += 2; const closing = name(); whitespace()
      if (text[offset++] !== '>' || stack.at(-1)?.name !== closing) invalid('标签未正确配对')
      stack.pop(); continue
    }
    if (text[offset] !== '<') {
      const end = text.indexOf('<', offset), next = end < 0 ? text.length : end, value = text.slice(offset, next)
      if (value.includes(']]>')) invalid('文本含无效结束标记')
      body(decode(value)); offset = next; continue
    }
    offset++; const tag = name(), attributes: { name: string; value: string }[] = [], names = new Set<string>()
    while (true) {
      const before = offset; whitespace()
      if (text[offset] === '>' || text.startsWith('/>', offset)) break
      if (before === offset) invalid('属性之间需要空格')
      const key = name()
      if (names.has(key) || ++attributesCount > 768 || attributes.length >= 256) invalid('属性重复或数量超限')
      names.add(key); whitespace()
      if (text[offset++] !== '=') invalid('属性缺少等号')
      whitespace(); const quote = text[offset++]
      if (quote !== '"' && quote !== "'") invalid('属性必须使用引号')
      const end = text.indexOf(quote, offset)
      if (end < 0 || text.slice(offset, end).includes('<')) invalid('属性值无效')
      attributes.push({ name: key, value: decode(text.slice(offset, end).replace(/[\t\r\n]/g, ' ')) }); offset = end + 1
    }
    const parentNamespaces = stack.at(-1)?.namespaces ?? new Map([['xml', xmpNamespaces.xml]])
    const namespaces = new Map(parentNamespaces)
    for (const attribute of attributes) if (attribute.name === 'xmlns' || attribute.name.startsWith('xmlns:')) {
      const prefix = attribute.name === 'xmlns' ? '' : attribute.name.slice(6), uri = attribute.value
      if (prefix === 'xmlns' || prefix && !uri || /\s/.test(uri) || uri === 'http://www.w3.org/2000/xmlns/' || prefix !== 'xml' && uri === xmpNamespaces.xml) invalid('命名空间声明无效')
      if (Object.hasOwn(xmpNamespaces, prefix) && uri !== xmpNamespaces[prefix as keyof typeof xmpNamespaces]) invalid(`不允许混淆 ${prefix} 命名空间`)
      if (prefix && parentNamespaces.has(prefix) && parentNamespaces.get(prefix) !== uri) invalid('不允许重新绑定命名空间前缀')
      namespaces.set(prefix, uri)
    }
    const element: ColorGradeXmlElement = { ...resolved(tag, namespaces), attributes: [], children: [], text: '' }, expanded = new Set<string>()
    for (const attribute of attributes) {
      if (attribute.name === 'xmlns' || attribute.name.startsWith('xmlns:')) continue
      const identity = resolved(attribute.name, namespaces, true), key = `${identity.uri}\u0000${identity.local}`
      if (expanded.has(key)) invalid('同一命名空间属性重复')
      expanded.add(key)
      if (['href', 'resource', 'schemalocation', 'base', 'nonamespaceschemalocation'].includes(identity.local.toLowerCase()) || identity.uri === xmpNamespaces.rdf && identity.local === 'about' && attribute.value !== '') invalid('不允许外部引用')
      element.attributes.push({ ...identity, value: attribute.value })
    }
    if (++count > 512 || stack.length >= 16) invalid('标签数量或嵌套深度超限')
    if (stack.length) stack[stack.length - 1].element.children.push(element)
    else { if (root) invalid('只能包含一个根标签'); root = element }
    if (text.startsWith('/>', offset)) offset += 2
    else { offset++; stack.push({ name: tag, element, namespaces }) }
  }
  if (!root || stack.length) invalid('文件不完整')
  return root
}
