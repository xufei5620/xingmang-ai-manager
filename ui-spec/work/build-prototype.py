from pathlib import Path
import re,sys

root = Path(__file__).resolve().parent
source = root / 'base-template.html'
target = (root.parent) / ('integration-preview.html' if '--staging' in sys.argv else 'prototype/星芒AI管理工具-可交互原型.html')
text = source.read_text(encoding='utf-8')
css = (root / 'prototype.css').read_text(encoding='utf-8')
sidebar_fix = root / 'sidebar-collapse-fix.css'
if sidebar_fix.exists():
    css += '\n' + sidebar_fix.read_text(encoding='utf-8')
js = (root / 'prototype.js').read_text(encoding='utf-8')
module_dir = root / 'modules'
modules = sorted(module_dir.glob('*.js')) if module_dir.exists() else []
if modules:
    js = re.sub(r'initProto\(\);\s*$', '', js)
    js += '\n' + '\n'.join(p.read_text(encoding='utf-8') for p in modules) + "\ninitProto();\nif (location.hash === '#welcome' && typeof A.guideScene === 'function') A.guideScene('welcome'); else render();\n"
    css += '\n' + '\n'.join(p.read_text(encoding='utf-8') for p in sorted(module_dir.glob('*.css')))
for sprite in sorted(module_dir.glob('*-icons.svg')):
    for match in re.finditer(r'<symbol\b[^>]*\bid="(i-[^"]+)"[^>]*>[\s\S]*?</symbol>', sprite.read_text(encoding='utf-8')):
        identifier = match.group(1)
        pattern = r'<symbol\b[^>]*\bid="'+re.escape(identifier)+r'"[^>]*>[\s\S]*?</symbol>'
        text, count = re.subn(pattern, lambda _:match.group(0), text, count=1)
        if count == 0: text = text.replace('</defs>',match.group(0)+'</defs>',1)
text = re.sub(r'(?s)<style>.*?</style>', lambda _: '<style>\n'+css+'\n</style>', text, count=1)
text = re.sub(r'(?s)<script>.*?</script>', lambda _: '<script>\n'+js+'\n</script>', text, count=1)
text = text.replace('完整可交互原型 v2', '可交互原型 v3.0 · 小白与三平台设计')
if (module_dir / '97-tray.js').exists():
    text = text.replace('可交互原型 v3.0 ·', '可交互原型 v3.0.1 ·')
if (module_dir / '98-restore.js').exists():
    text = text.replace('可交互原型 v3.0.1 ·', '可交互原型 v3.0.4 ·')
if (module_dir / '99-skin.js').exists():
    text = text.replace('可交互原型 v3.0.4 ·', '可交互原型 v3.1.1 ·')
text = text.replace('所有按钮都能点 ·', '演示数据 · 未连接业务服务 ·')
target.write_text(text, encoding='utf-8')
print(str(target))
