"""Rebuild realesr-general-x4v3.onnx from the official Real-ESRGAN release.

Usage (Python 3.10+, numpy, onnx; onnxruntime only for the self-check):

    curl -fLO https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesr-general-x4v3.pth
    sha256sum realesr-general-x4v3.pth   # must match manifest.json source.sha256
    python3 -I convert-realesr-general-x4v3.py realesr-general-x4v3.pth realesr-general-x4v3.onnx --verify

The output is byte-for-byte reproducible; its sha256 must match manifest.json
onnx.sha256 and electron/image-upscale-service.ts imageUpscaleModelSha256.

Why not torch.onnx.export: torch is a 200+ MB dependency for a network this
small, and the exporter's output changes between torch versions. The graph is
written op by op instead, following realesrgan/archs/srvgg_arch.py
(SRVGGNetCompact: num_feat=64, num_conv=32, upscale=4, PReLU):

    34 x [Conv 3x3, pad 1] with PReLU after all but the last
    DepthToSpace(4, CRD)                 == torch.nn.PixelShuffle(4)
    + Resize(x, 4, nearest, asymmetric)  == F.interpolate(x, scale_factor=4, mode='nearest')

The .pth is a torch zip archive whose data.pkl only references
collections.OrderedDict, torch._utils._rebuild_tensor_v2 and torch.FloatStorage.
The unpickler below refuses every other global, so the archive cannot run code.

--verify runs the ONNX graph and an independent numpy implementation of the
torch module on the same random input and fails unless they agree to 1e-4.
"""
import argparse
import collections
import hashlib
import pickle
import zipfile

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper

NUM_CONV = 32
UPSCALE = 4


class FloatStorage:
    pass


def load_params(source):
    archive = zipfile.ZipFile(source)
    prefix = archive.namelist()[0].split('/', 1)[0]

    def rebuild_tensor(storage, offset, size, stride, *rest):
        item = storage.itemsize
        view = np.lib.stride_tricks.as_strided(storage[offset:], shape=tuple(size), strides=tuple(s * item for s in stride))
        return np.ascontiguousarray(view)

    class RestrictedUnpickler(pickle.Unpickler):
        def find_class(self, module, name):
            if (module, name) == ('collections', 'OrderedDict'):
                return collections.OrderedDict
            if (module, name) == ('torch._utils', '_rebuild_tensor_v2'):
                return rebuild_tensor
            if (module, name) == ('torch', 'FloatStorage'):
                return FloatStorage
            raise pickle.UnpicklingError(f'refused global {module}.{name}')

        def persistent_load(self, pid):
            kind, storage_type, key, _location, numel = pid
            if kind != 'storage' or storage_type is not FloatStorage:
                raise pickle.UnpicklingError(f'unexpected storage {pid!r}')
            data = np.frombuffer(archive.read(f'{prefix}/data/{key}'), dtype='<f4')
            if data.size != numel:
                raise pickle.UnpicklingError('storage size mismatch')
            return data

    with archive.open(f'{prefix}/data.pkl') as handle:
        loaded = RestrictedUnpickler(handle).load()
    params = loaded['params'] if 'params' in loaded else loaded
    if len(params) != (NUM_CONV + 2) * 2 + (NUM_CONV + 1):
        raise ValueError('unexpected tensor count; is this realesr-general-x4v3.pth?')
    return params


def build_model(params):
    nodes = []
    initializers = []
    current = 'input'

    def add_init(name, array):
        initializers.append(numpy_helper.from_array(np.asarray(array, dtype=np.float32), name))

    for index in range(NUM_CONV + 2):
        conv = index * 2
        add_init(f'body.{conv}.weight', params[f'body.{conv}.weight'])
        add_init(f'body.{conv}.bias', params[f'body.{conv}.bias'])
        out = f'conv{index}'
        nodes.append(helper.make_node('Conv', [current, f'body.{conv}.weight', f'body.{conv}.bias'], [out], kernel_shape=[3, 3], pads=[1, 1, 1, 1], strides=[1, 1]))
        current = out
        if index <= NUM_CONV:
            add_init(f'body.{conv + 1}.weight', params[f'body.{conv + 1}.weight'].reshape(-1, 1, 1))
            out = f'prelu{index}'
            nodes.append(helper.make_node('PRelu', [current, f'body.{conv + 1}.weight'], [out]))
            current = out

    nodes.append(helper.make_node('DepthToSpace', [current], ['shuffled'], blocksize=UPSCALE, mode='CRD'))
    add_init('upscale_scales', np.array([1, 1, UPSCALE, UPSCALE], dtype=np.float32))
    nodes.append(helper.make_node('Resize', ['input', '', 'upscale_scales'], ['base'], mode='nearest', coordinate_transformation_mode='asymmetric', nearest_mode='floor'))
    nodes.append(helper.make_node('Add', ['shuffled', 'base'], ['output']))

    graph = helper.make_graph(
        nodes,
        'realesr-general-x4v3',
        [helper.make_tensor_value_info('input', TensorProto.FLOAT, [1, 3, 'height', 'width'])],
        [helper.make_tensor_value_info('output', TensorProto.FLOAT, [1, 3, 'height_x4', 'width_x4'])],
        initializers,
    )
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid('', 17)], producer_name='xingmang-convert-realesr', producer_version='1')
    model.ir_version = 8
    model.doc_string = 'Real-ESRGAN realesr-general-x4v3 (BSD-3-Clause, Copyright (c) 2021, Xintao Wang)'
    onnx.checker.check_model(model)
    return model


def reference_forward(params, x):
    """The torch module, written out in numpy (float64)."""
    def conv(value, weight, bias):
        channels, height, width = value.shape
        padded = np.pad(value, ((0, 0), (1, 1), (1, 1)))
        out = np.zeros((weight.shape[0], height, width), dtype=np.float64)
        for ky in range(3):
            for kx in range(3):
                out += np.einsum('oc,chw->ohw', weight[:, :, ky, kx], padded[:, ky:ky + height, kx:kx + width])
        return out + bias[:, None, None]

    out = x.astype(np.float64)
    for layer in range((NUM_CONV + 2) * 2 - 1):
        if layer % 2 == 0:
            out = conv(out, params[f'body.{layer}.weight'], params[f'body.{layer}.bias'])
        else:
            slope = params[f'body.{layer}.weight'][:, None, None]
            out = np.where(out >= 0, out, slope * out)
    channels = out.shape[0] // (UPSCALE * UPSCALE)
    height, width = out.shape[1:]
    shuffled = np.zeros((channels, height * UPSCALE, width * UPSCALE))
    for channel in range(channels):
        for i in range(UPSCALE):
            for j in range(UPSCALE):
                shuffled[channel, i::UPSCALE, j::UPSCALE] = out[channel * UPSCALE * UPSCALE + i * UPSCALE + j]
    return shuffled + np.repeat(np.repeat(x, UPSCALE, axis=1), UPSCALE, axis=2)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('source')
    parser.add_argument('output')
    parser.add_argument('--verify', action='store_true')
    args = parser.parse_args()
    params = load_params(args.source)
    data = build_model(params).SerializeToString(deterministic=True)
    with open(args.output, 'wb') as handle:
        handle.write(data)
    print('wrote', args.output, len(data), 'bytes, sha256', hashlib.sha256(data).hexdigest())
    if args.verify:
        import onnxruntime
        x = np.random.default_rng(1).random((3, 13, 17)).astype(np.float32)
        session = onnxruntime.InferenceSession(args.output, providers=['CPUExecutionProvider'])
        got = session.run(None, {'input': x[None]})[0][0]
        difference = float(np.abs(got - reference_forward(params, x)).max())
        print('max difference against the numpy reference:', difference)
        if difference > 1e-4:
            raise SystemExit('verification failed')


if __name__ == '__main__':
    main()
