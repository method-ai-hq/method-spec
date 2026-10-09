# Method runtime: record what a `run` step's Python process did, for observed_effects.
# The runtime puts this folder on PYTHONPATH and names an output file in METHOD_OBSERVE_FILE.
# It removes both from the environment before the script starts, so the script sees the same
# environment, argv, __main__, stdin, and stdout as without observation. Observations go to the
# file at exit, never to stdout. Values of environment variables, URLs, and command arguments are
# never recorded: only names, hosts, paths, and program names.
import os
import sys


def _method_observe():
    target = os.environ.pop('METHOD_OBSERVE_FILE', None)
    original = os.environ.pop('METHOD_OBSERVE_PYTHONPATH', None)
    here = os.path.dirname(os.path.abspath(__file__))
    if original is None:
        os.environ.pop('PYTHONPATH', None)
    else:
        os.environ['PYTHONPATH'] = original
    sys.path[:] = [p for p in sys.path if os.path.abspath(p or '.') != here]
    _chain(here)
    if not target:
        return

    import atexit
    import json
    import site

    cap = 2000
    sets = {'network': set(), 'reads': set(), 'writes': set(), 'env': set(), 'runs': set()}
    state = {'active': True, 'dropped': False}
    skip = [here, os.path.dirname(target)]
    for name in ('prefix', 'base_prefix', 'exec_prefix', 'base_exec_prefix'):
        value = getattr(sys, name, None)
        if value:
            skip.append(value)
    try:
        skip.extend(site.getsitepackages())
        skip.append(site.getusersitepackages())
    except Exception:
        pass
    skip.append(os.path.dirname(os.__file__))
    skip = [p for p in skip if p]
    skip = tuple(sorted({os.path.join(p, '') for p in skip + [os.path.realpath(p) for p in skip]} | {'/dev/'}))
    write_flags = os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_APPEND | os.O_TRUNC
    shells = ('sh', 'bash', 'zsh', 'dash')

    def note(kind, value):
        if not value:
            return
        found = sets[kind]
        if len(found) < cap:
            found.add(value)
        elif value not in found:
            state['dropped'] = True

    def path_of(value):
        if isinstance(value, os.PathLike):
            value = os.fspath(value)
        if isinstance(value, bytes):
            value = os.fsdecode(value)
        if not isinstance(value, str):
            return None
        value = os.path.abspath(value)
        if value.startswith(skip) or value.endswith(('.pyc', '.pyo')):
            return None
        return value

    def program(first, argv):
        if isinstance(argv, (str, bytes)):
            argv = os.fsdecode(argv).split()
        argv = [os.fsdecode(a) if isinstance(a, bytes) else str(a) for a in (argv or [])]
        name = os.path.basename(os.fsdecode(first) if isinstance(first, bytes) else str(first or (argv[0] if argv else '')))
        if name in shells and len(argv) > 2 and argv[1] == '-c':
            words = argv[2].split()
            name = os.path.basename(words[0]) if words else name
        return name

    def on_open(args):
        path = path_of(args[0])
        if path is None:
            return
        mode, flags = args[1], args[2] if len(args) > 2 else 0
        writing = any(c in mode for c in 'wax+') if isinstance(mode, str) else bool((flags or 0) & write_flags)
        note('writes' if writing else 'reads', path)

    def on_connect(args):
        address = args[1]
        if isinstance(address, tuple) and address and isinstance(address[0], str):
            note('network', address[0])

    def on_lookup(args):
        host = args[0]
        if isinstance(host, bytes):
            host = host.decode('ascii', 'replace')
        if isinstance(host, str):
            note('network', host)

    def write_path(index):
        def handle(args):
            path = path_of(args[index])
            if path is not None:
                note('writes', path)
        return handle

    def read_path(args):
        path = path_of(args[0] if args else '.')
        if path is not None:
            note('reads', path)

    def copy(args):
        source, dest = path_of(args[0]), path_of(args[1])
        if source:
            note('reads', source)
        if dest:
            note('writes', dest)

    handlers = {
        'open': on_open,
        'socket.connect': on_connect,
        'socket.getaddrinfo': on_lookup,
        'socket.gethostbyname': on_lookup,
        'subprocess.Popen': lambda a: note('runs', program(a[0], a[1])),
        'os.system': lambda a: note('runs', program(None, a[0])),
        'os.exec': lambda a: note('runs', program(a[0], a[1])),
        'os.posix_spawn': lambda a: note('runs', program(a[0], a[1])),
        'os.spawn': lambda a: note('runs', program(a[1], a[2])),
        'os.putenv': lambda a: note('env', os.fsdecode(a[0])),
        'os.unsetenv': lambda a: note('env', os.fsdecode(a[0])),
        'os.listdir': read_path,
        'os.scandir': read_path,
        'os.remove': write_path(0),
        'os.rmdir': write_path(0),
        'os.mkdir': write_path(0),
        'os.rename': lambda a: (write_path(0)(a), write_path(1)(a)),
        'shutil.copyfile': copy,
    }

    def hook(event, args):
        if not state['active']:
            return
        handler = handlers.get(event)
        if handler is not None:
            try:
                handler(args)
            except Exception:
                pass

    environ_class = type(os.environ)

    plumbing = (os.path.join('', 'os.py'), '_collections_abc.py')

    def from_script():
        # The first caller outside os.environ's own plumbing decides; the standard library's own reads do not count.
        frame = sys._getframe(2)
        while frame is not None:
            name = frame.f_code.co_filename
            if name in ('<frozen os>', '<frozen _collections_abc>'):
                frame = frame.f_back
                continue
            if not (name.startswith(skip) and name.endswith(plumbing)):
                return not name.startswith(skip) and not name.startswith('<frozen')
            frame = frame.f_back
        return False

    class ObservedEnviron(environ_class):
        def __getitem__(self, key):
            if state['active'] and isinstance(key, str) and from_script():
                note('env', key)
            return environ_class.__getitem__(self, key)

    try:
        os.environ.__class__ = ObservedEnviron
    except TypeError:
        pass

    def dump():
        state['active'] = False
        data = {name: sorted(values) for name, values in sets.items()}
        if state['dropped']:
            data['dropped'] = True
        try:
            with open(target, 'w') as handle:
                json.dump(data, handle)
        except Exception:
            pass

    atexit.register(dump)
    sys.addaudithook(hook)


def _chain(here):
    """Run the sitecustomize module that this one hides, if there is one."""
    try:
        import importlib.machinery
        import importlib.util
        spec = importlib.machinery.PathFinder.find_spec('sitecustomize', sys.path)
        if spec is None or spec.origin is None or os.path.dirname(os.path.abspath(spec.origin)) == here:
            return
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        sys.modules['sitecustomize'] = module
    except Exception:
        pass


_method_observe()
del _method_observe, _chain
