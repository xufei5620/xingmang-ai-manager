import { useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { Button, Dialog, Textarea } from '../../ui'
import { MAX_CHAT_PHRASE_LENGTH, MAX_CHAT_PHRASES } from './state'

// 「常用的话」（Fable 第二轮 Q7）：经常要说的一句话或一段固定要求存在这里，点一下填进输入框，不直接发。
// 打开时先把输入框里已经写的字放进「存一条新的」：刚写好一段想存下来，点开就能存。
export function PhrasesDialog({ phrases, draft, onUse, onSave, onRemove, onClose }: { phrases: readonly string[]; draft: string; onUse: (phrase: string) => void; onSave: (text: string) => void; onRemove: (index: number) => void; onClose: () => void }) {
  const [initial] = useState(() => draft.trim().slice(0, MAX_CHAT_PHRASE_LENGTH))
  const [text, setText] = useState(initial)
  const full = phrases.length >= MAX_CHAT_PHRASES && !phrases.includes(text.trim())
  // 带过来的输入框里的字没动过就不算没存的改动：关掉以后它还在输入框里，什么都没丢。
  const dirty = text.trim() !== '' && text.trim() !== initial && !phrases.includes(text.trim())
  const save = () => {
    if (!text.trim() || full) return
    onSave(text)
    setText('')
  }
  return <Dialog open title="常用的话" subtitle="点「填进输入框」只是填好，看一眼再发。" width={480} dirty={dirty} onClose={onClose} testId="chat-phrases-dialog" footer={<Button onClick={onClose} testId="chat-phrases-close">关闭</Button>}>
    <div className="chat-phrases">
      {phrases.length ? <ul className="chat-phrase-list" data-testid="chat-phrases-list">{phrases.map((phrase, index) => <li key={phrase} className="chat-phrase">
        <p className="chat-phrase-text" title={phrase}>{phrase}</p>
        <span className="chat-phrase-actions"><Button size="sm" onClick={() => onUse(phrase)} testId="chat-phrase-use">填进输入框</Button><Button variant="ghost" size="sm" icon={Trash2} aria-label="删除" title="删除" onClick={() => onRemove(index)} testId="chat-phrase-remove" /></span>
      </li>)}</ul> : <p className="chat-phrases-empty" data-testid="chat-phrases-empty">还没有存过常用的话。把经常要说的话存在这里，下次一点就填好。</p>}
      <Textarea label="存一条新的" value={text} rows={3} maxLength={MAX_CHAT_PHRASE_LENGTH} placeholder="比如：回答尽量简短，用大白话，不要用表格" hint={full ? `最多存 ${MAX_CHAT_PHRASES} 条，先删掉几条再存。` : undefined} onChange={(event) => setText(event.target.value)} testId="chat-phrase-input" />
      <span className="chat-phrase-save"><Button icon={Plus} disabled={!text.trim() || full} onClick={save} testId="chat-phrase-save">存一条</Button></span>
    </div>
  </Dialog>
}
