import argparse
import difflib
import importlib.util
import json
import os
import pathlib
import subprocess
import sys
import shutil

parser = argparse.ArgumentParser(description='Build the pinned OpenCV GrabCut runtime; inputs must be verified from manifest.json first')
parser.add_argument('--workdir', required=True, help='Directory containing the verified official source and toolchain archives, extracted as documented')
parser.add_argument('--node', default=shutil.which('node'), help='Absolute path to a Node.js 22 runtime')
cli = parser.parse_args()
if not cli.node:
    parser.error('--node is required when node is unavailable on PATH')
root = pathlib.Path(cli.workdir).resolve()
source = root / 'opencv-4.13.0'
sdk = root / 'emsdk-4.0.20' / 'upstream'
node = pathlib.Path(cli.node).resolve()
cmake_dir = root / 'cmake-3.31.6' / 'cmake' / 'data' / 'bin'
config = root / '.emscripten'
config.write_text('\n'.join([
    'LLVM_ROOT = ' + repr(str(sdk / 'bin')),
    'BINARYEN_ROOT = ' + repr(str(sdk)),
    'NODE_JS = [' + repr(str(node)) + ']',
    'CACHE = ' + repr(str(root / 'emscripten-cache')),
]) + '\n')
env = os.environ.copy()
env.update({'EM_CONFIG': str(config), 'EMSCRIPTEN_ROOT': str(sdk / 'emscripten'),
            'EMSDK': str(root / 'emsdk-4.0.20'), 'EM_CACHE': str(root / 'emscripten-cache'),
            'EMCC_CORES': '2', 'CMAKE_BUILD_PARALLEL_LEVEL': '2',
            'PATH': str(cmake_dir) + os.pathsep + str(node.parent) + os.pathsep + env.get('PATH', '')})

# Upstream fixes the initial / maximum heap in its JS linker target. Keep a
# source patch as part of build provenance; this is a bounded build setting,
# not a post-build rewrite of executable code or a removed safety check.
filename = source / 'modules/js/CMakeLists.txt'
original = filename.read_text()
old = '-s TOTAL_MEMORY=128MB -s WASM_MEM_MAX=1GB'
new = '-s INITIAL_MEMORY=32MB -s MAXIMUM_MEMORY=512MB'
if old in original:
    changed = original.replace(old, new)
    filename.write_text(changed)
    (root / 'bounded-memory.patch').write_text(''.join(difflib.unified_diff(original.splitlines(True), changed.splitlines(True), fromfile='a/modules/js/CMakeLists.txt', tofile='b/modules/js/CMakeLists.txt')))
elif new not in original:
    raise RuntimeError('Upstream memory settings changed unexpectedly')

spec = importlib.util.spec_from_file_location('upstream_build_js', source / 'platforms/js/build_js.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
options = argparse.Namespace(build_dir=str(root / 'asmjs-build'), opencv_dir=str(source),
    emscripten_dir=str(sdk / 'emscripten'), build_wasm=False, disable_wasm=True,
    disable_single_file=False, threads=False, simd=False, enable_exception=True,
    webnn=False, build_doc=False, build_wasm_intrin_test=False, extra_modules=None,
    build_flags='-s DYNAMIC_EXECUTION=0 -s EXPORT_ES6=1 -s ENVIRONMENT=worker,node -O3',
    cmake_option=['-DBUILD_LIST=core,imgproc,js', '-DCMAKE_CXX_STANDARD=17',
      '-DOPENCV_VCSVERSION=4.13.0-xingmang-noeval-r1', '-DOPENCV_TIMESTAMP=',
      '-DBUILD_INFO_SKIP_TIMESTAMP=ON', '-DBUILD_INFO_SKIP_SYSTEM_VERSION=ON',
      '-DBUILD_TESTS=OFF', '-DBUILD_PERF_TESTS=OFF', '-DBUILD_EXAMPLES=OFF',
      '-DWITH_PTHREADS_PF=OFF', '-DWITH_OPENCL=OFF', '-DWITH_IPP=OFF',
      '-DOPENCV_ENABLE_NONFREE=OFF', '-DBUILD_opencv_dnn=OFF',
      '-DBUILD_opencv_calib3d=OFF', '-DBUILD_opencv_features2d=OFF',
      '-DBUILD_opencv_flann=OFF', '-DBUILD_opencv_photo=OFF',
      '-DBUILD_opencv_video=OFF', '-DBUILD_opencv_objdetect=OFF'])
builder = module.Builder(options)
args = builder.get_cmake_cmd()
args[0] = str(cmake_dir / 'cmake')
# CMake's -D assignments receive literal argv values, without shell quoting.
args = [arg.replace("='", '=', 1)[:-1] if "='" in arg and arg.endswith("'") else arg for arg in args]
args += [str(source)]
env['OPENCV_JS_WHITELIST'] = str(root / 'grabcut-whitelist.py')
plan = {'upstream': 'OpenCV 4.13.0', 'emscripten': '4.0.20', 'cmake': '3.31.6',
        'configureArgv': args, 'buildArgv': ['/usr/bin/make', '-j', '2', 'opencv_js'],
        'whitelist': (root / 'grabcut-whitelist.py').read_text(), 'maxHeapBytes': 536870912,
        'initialHeapBytes': 33554432, 'threads': False, 'dynamicExecution': False,
        'outputFormat': 'asmjs-esm-factory', 'sourcePatch': 'bounded-memory.patch'}
(root / 'build-plan.json').write_text(json.dumps(plan, indent=2) + '\n')
with (root / 'configure.log').open('w') as log:
    subprocess.run(args, cwd=builder.build_dir, env=env, stdout=log, stderr=subprocess.STDOUT, check=True)
print('Configuration passed', flush=True)
with (root / 'compile.log').open('w') as log:
    subprocess.run(plan['buildArgv'], cwd=builder.build_dir, env=env, stdout=log, stderr=subprocess.STDOUT, check=True)
print('Compilation passed', flush=True)
