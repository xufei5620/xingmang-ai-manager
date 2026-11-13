// @renderer-importable: bundled into the renderer, so no Node or Electron here or in what it value-imports (I6).

// Imports nothing on purpose: the renderer value-imports this file (registered in
// scripts/verify-renderer-boundary.test.cjs), so it must stay free of Node APIs (I6).

// 注册邮件里的验证码（深查·表单 F8）：注册框提交前、主进程收下注册请求时都先过这一遍，
// 两边交给账号服务的是同一串。
//
// new-api 发的验证码是 UUID 去掉横杠的前 6 位（controller/misc.go 的 SendEmailVerification
// 调 common.GenerateVerificationCode(6)），也就是小写十六进制，比如 3fa9c1；注册时
// common/verification.go 的 VerifyCodeWithKey 用 == 一字不差地比，大小写、空格都算错。
// 客户照着邮件抄，常见的走样是：大写锁着打成 3FA9C1、全角模式打出３ｆａ９ｃ１、
// 从邮件复制带出空格或零宽字符。这些都替他理顺。
//
// 只有理顺后整串正好是 6 位十六进制才转小写：账号服务哪天换了验证码的样子，
// 别的写法原样交给它判断，不替它改大小写。这里不放宽任何检查，对不对仍由服务端一字不差地比。
const invisibleCharacters = /[\s​-‍⁠﻿]/g
const fullWidthLettersAndDigits = /[０-９Ａ-Ｚａ-ｚ]/g
const lowercaseHexCodeShape = /^[0-9a-f]{6}$/i

/** 去掉空白（含全角空格）和零宽字符，全角字母数字换半角；是 6 位十六进制时转小写。 */
export function normalizeEmailVerificationCode(value: string): string {
  const halfWidth = value
    .replace(invisibleCharacters, '')
    .replace(fullWidthLettersAndDigits, (character) => String.fromCharCode(character.charCodeAt(0) - 0xfee0))
  return lowercaseHexCodeShape.test(halfWidth) ? halfWidth.toLowerCase() : halfWidth
}
