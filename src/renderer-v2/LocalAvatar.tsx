import { useCallback, useEffect, useRef, useState } from 'react'
import { RotateCcw, Save } from 'lucide-react'
import { Button, Dialog, Input, Notice } from './ui'
import {
  avatarInitial,
  avatarStorageKey,
  decodeAvatarImage,
  defaultAvatarCrop,
  drawAvatarCrop,
  readSavedAvatar,
  writeSavedAvatar,
  type AvatarCrop,
  type AvatarIdentity,
} from './local-avatar'

const avatarChangedEvent = 'xingmang-v2-local-avatar-changed'
export function useLocalAvatar(identity: AvatarIdentity | null) {
  let key: string | null = null
  try {
    if (identity) key = avatarStorageKey(identity)
  } catch {
    /* Incomplete identity displays the fallback initial. */
  }
  const keyRef = useRef(key)
  keyRef.current = key
  const [record, setRecord] = useState<{
    key: string | null
    dataUrl: string | null
    error: string
  }>({ key: null, dataUrl: null, error: '' })
  const refresh = useCallback(() => {
    if (!key) {
      setRecord({ key: null, dataUrl: null, error: '' })
      return
    }
    try {
      setRecord({ key, dataUrl: readSavedAvatar(localStorage, key), error: '' })
    } catch {
      setRecord({
        key,
        dataUrl: null,
        error: '本机头像暂时无法读取，可以重新设置。',
      })
    }
  }, [key])
  useEffect(() => {
    refresh()
    const local = (event: Event) => {
      if (event instanceof CustomEvent && event.detail === key) refresh()
    }
    const external = (event: StorageEvent) => {
      if (event.key === key || event.key === null) refresh()
    }
    window.addEventListener(avatarChangedEvent, local)
    window.addEventListener('storage', external)
    return () => {
      window.removeEventListener(avatarChangedEvent, local)
      window.removeEventListener('storage', external)
    }
  }, [key, refresh])
  const save = (dataUrl: string) => {
    if (!key || keyRef.current !== key)
      throw new Error('账号已变化，请为当前账号重新选择头像。')
    writeSavedAvatar(localStorage, key, dataUrl)
    setRecord({ key, dataUrl, error: '' })
    window.dispatchEvent(new CustomEvent(avatarChangedEvent, { detail: key }))
  }
  return {
    key,
    dataUrl: record.key === key ? record.dataUrl : null,
    error: record.key === key ? record.error : '',
    save,
  }
}

export function LocalAvatar({
  identity,
  name,
  size = 36,
  testId,
}: {
  identity: AvatarIdentity | null
  name: string
  size?: 36 | 72
  testId?: string
}) {
  const avatar = useLocalAvatar(identity)
  return (
    <span
      className={`v2-local-avatar v2-local-avatar-${size}`}
      role="img"
      aria-label={`${name || '星芒账号'}的头像`}
      data-testid={testId}
    >
      {avatar.dataUrl ? (
        <img src={avatar.dataUrl} alt="" />
      ) : (
        avatarInitial(name)
      )}
    </span>
  )
}

export function LocalAvatarDialog({
  identity,
  name,
  onClose,
}: {
  identity: AvatarIdentity
  name: string
  onClose: () => void
}) {
  const avatar = useLocalAvatar(identity)
  const [crop, setCrop] = useState<AvatarCrop>(defaultAvatarCrop)
  const [bitmap, setBitmap] = useState<ImageBitmap | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [filename, setFilename] = useState('')
  const preview = useRef<HTMLCanvasElement>(null)
  const request = useRef(0)
  const imageRef = useRef<ImageBitmap | null>(null)
  const activeKey = useRef(avatar.key)
  activeKey.current = avatar.key
  useEffect(() => {
    request.current++
    setBitmap(null)
    setFilename('')
    setCrop(defaultAvatarCrop)
    setError('')
    setBusy(false)
    return () => {
      request.current++
      imageRef.current?.close()
      imageRef.current = null
    }
  }, [avatar.key])
  useEffect(() => {
    if (!bitmap || !preview.current) return
    try {
      drawAvatarCrop(preview.current, bitmap, crop)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '头像预览没有准备好。')
    }
  }, [bitmap, crop])
  const choose = async (file: File | undefined) => {
    if (!file) return
    const id = ++request.current
    const owner = avatar.key
    setBusy(true)
    setError('')
    try {
      const image = await decodeAvatarImage(file)
      if (request.current !== id || owner !== activeKey.current) {
        image.close()
        return
      }
      imageRef.current?.close()
      imageRef.current = image
      setCrop(defaultAvatarCrop)
      setBitmap(image)
      setFilename(file.name)
    } catch (cause) {
      if (request.current === id && owner === activeKey.current)
        setError(
          cause instanceof Error
            ? cause.message
            : '这张图片无法打开，请重新选择。',
        )
    } finally {
      if (request.current === id && owner === activeKey.current) setBusy(false)
    }
  }
  const save = () => {
    if (!bitmap || !preview.current || busy) return
    setError('')
    try {
      drawAvatarCrop(preview.current, bitmap, crop)
      avatar.save(preview.current.toDataURL('image/png'))
      onClose()
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : '头像没有保存成功，预览已保留。',
      )
    }
  }
  return (
    <Dialog
      open
      title="更换头像"
      subtitle="只保存在当前设备，不会上传到账户服务器。"
      width={480}
      onClose={onClose}
      dirty={Boolean(bitmap)}
      busy={busy}
      testId="account-avatar-dialog"
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button
            variant="primary"
            icon={Save}
            disabled={!bitmap}
            loading={busy}
            onClick={save}
            testId="account-avatar-save"
          >
            保存本机头像
          </Button>
        </>
      }
    >
      {error && (
        <Notice
          tone="bad"
          title="头像没有保存"
          body={error}
          testId="account-avatar-error"
        />
      )}
      <Input
        label="选择图片"
        type="file"
        accept="image/png,image/jpeg,image/webp"
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          void choose(file)
        }}
        hint="PNG、JPEG 或 WebP，不超过 2 MB。"
        testId="account-avatar-file"
      />
      <div className="v2-avatar-crop-preview">
        {bitmap ? (
          <canvas
            ref={preview}
            width={256}
            height={256}
            aria-label="方形头像裁剪预览"
            data-testid="account-avatar-preview"
          />
        ) : (
          <LocalAvatar identity={identity} name={name} size={72} />
        )}
        <p>{filename || '选择图片后调整方形裁剪区域'}</p>
      </div>
      {bitmap && (
        <div className="v2-avatar-crop-controls">
          <Input
            label="放大"
            type="range"
            min="1"
            max="4"
            step="0.05"
            value={crop.zoom}
            onChange={(event) =>
              setCrop((value) => ({
                ...value,
                zoom: Number(event.target.value),
              }))
            }
            testId="account-avatar-zoom"
          />
          <Input
            label="左右位置"
            type="range"
            min="0"
            max="100"
            step="1"
            value={crop.horizontal}
            onChange={(event) =>
              setCrop((value) => ({
                ...value,
                horizontal: Number(event.target.value),
              }))
            }
            testId="account-avatar-horizontal"
          />
          <Input
            label="上下位置"
            type="range"
            min="0"
            max="100"
            step="1"
            value={crop.vertical}
            onChange={(event) =>
              setCrop((value) => ({
                ...value,
                vertical: Number(event.target.value),
              }))
            }
            testId="account-avatar-vertical"
          />
          <Button
            size="sm"
            icon={RotateCcw}
            onClick={() => setCrop(defaultAvatarCrop)}
          >
            重置裁剪
          </Button>
        </div>
      )}
    </Dialog>
  )
}
