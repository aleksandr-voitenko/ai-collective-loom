"""Validate and normalize cold-volume archives before any destination exists.

Never extract untrusted archive paths on the host. Emit only ordinary USTAR
files/directories; reject links, devices, aliases, special modes and sparse files.
"""
import pathlib
import sys
import tarfile

source, destination = sys.argv[1:]
try:
    names = set()
    total = 0
    with tarfile.open(source, 'r:') as incoming, tarfile.open(destination, 'w', format=tarfile.USTAR_FORMAT) as outgoing:
        for member in incoming:
            name = member.name
            while name.startswith('./'):
                name = name[2:]
            if name in ('', '.') and member.isdir():
                continue
            parts = name.rstrip('/').split('/')
            if (not name or name.startswith('/') or any(p in ('', '.', '..') for p in parts)
                    or '\\' in name or ':' in name or any(ord(c) < 32 or ord(c) == 127 for c in name)
                    or name in names or not (member.isfile() or member.isdir())
                    or member.mode & 0o7000 or member.sparse is not None):
                raise ValueError('unsafe archive')
            names.add(name)
            total += member.size
            if total > 1073741824 or len(names) > 100000:
                raise ValueError('archive bound')
            clean = tarfile.TarInfo(name)
            clean.type = tarfile.DIRTYPE if member.isdir() else tarfile.REGTYPE
            clean.size, clean.mode = member.size, member.mode
            clean.uid, clean.gid, clean.mtime = member.uid, member.gid, member.mtime
            outgoing.addfile(clean, incoming.extractfile(member) if member.isfile() else None)
    if not names:
        raise ValueError('empty archive')
except Exception:
    pathlib.Path(destination).unlink(missing_ok=True)
    sys.stderr.write('Unsafe or malformed recovery archive.\n')
    sys.exit(1)
