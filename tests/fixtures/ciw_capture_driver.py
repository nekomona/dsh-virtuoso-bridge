"""Contract driver for runtime/vb_ciw.py, run by tests/ciw-capture.test.mjs.

It imports the module with PYTHONPATH=../../runtime and drives a fake client:
the fake records every capture command and replays prepared log reads, so the
test can assert discovery, the warn-port flush, cursor based reads,
classification and the best-effort None paths without a live Virtuoso.
"""

import json

import vb_ciw

out = {}

FD_LISTING = (
    'total 0\n'
    'lrwx------. 1 u u 64 Nov 15 13:42 0 -> /dev/pts/21\n'
    'l-wx------. 1 u u 64 Nov 15 13:42 8 -> /home/username/CDS.log.1\n'
    'lr-x------. 1 u u 64 Nov 15 13:42 10 -> /home/username/CDS.log.1\n'
    'l-wx------. 1 u u 64 Nov 15 13:42 12 -> /home/username/CDS.log.1.cdslck\n'
)
out['fd_writable'] = vb_ciw.parse_fd_listing(FD_LISTING)
out['fd_none'] = vb_ciw.parse_fd_listing('total 0\nlrwx------. 1 u u 64 Nov 15 13:42 1 -> /dev/pts/21\n')
out['fd_readonly'] = vb_ciw.parse_fd_listing(
    'total 0\nlr-x------. 1 u u 64 Nov 15 13:42 10 -> /home/username/CDS.log.1\n'
    'l-wx------. 1 u u 64 Nov 15 13:42 12 -> /home/username/CDS.log.1.cdslck\n'
)
assert out['fd_writable'] == '/home/username/CDS.log.1', out['fd_writable']
assert out['fd_none'] is None, out['fd_none']
assert out['fd_readonly'] == '/home/username/CDS.log.1', out['fd_readonly']

out['read_split'] = list(vb_ciw.parse_read_output('SZ:184\n\\w *WARNING* hi\n'))
assert out['read_split'] == [184, '\\w *WARNING* hi\n'], out['read_split']
out['read_garbage'] = list(vb_ciw.parse_read_output('BusyError: lane poisoned'))
assert out['read_garbage'] == [None, 'BusyError: lane poisoned'], out['read_garbage']

TEXT = (
    '\\# Program start time: UTC 2026.11.13\n'
    '\\w *WARNING* (DB-270212): dbOpenCellViewByType: cannot open cellview\n'
    '\\e *Error* eval: unbound variable - Width\n'
    '\\o CDF: An error occurred when evaluating callback.\n'
    '\\o   Callback: w->display => Width (um)\n'
    '\\o just some chatter from another tool\n'
    '\\w *WARNING* (DB-270212): dbOpenCellViewByType: cannot open cellview\n'
)
classified = vb_ciw.classify_ciw_text(TEXT)
out['classified'] = classified
assert classified['warnings'] == 2, classified
assert classified['errors'] == 1, classified
assert classified['output'] == 1, classified
assert classified['otherLines'] == 3, classified
assert classified['lines'] == [
    '*WARNING* (DB-270212): dbOpenCellViewByType: cannot open cellview',
    '*Error* eval: unbound variable - Width',
    'CDF: An error occurred when evaluating callback.',
    '*WARNING* (DB-270212): dbOpenCellViewByType: cannot open cellview',
], classified['lines']
assert classified['levels'] == ['warning', 'error', 'output', 'warning'], classified['levels']
assert classified['truncated'] is False, classified

WARN = chr(92) + 'w '
repeated = vb_ciw.classify_ciw_text((WARN + 'same line' + chr(10)) * 3)
out['repeated'] = repeated
assert repeated['warnings'] == 3, repeated
assert repeated['lines'] == ['same line ... (last line repeated)'], repeated

capped = vb_ciw.classify_ciw_text('\\w one\n\\w two\n\\w three\n', max_lines=2)
out['capped'] = capped
assert capped['truncated'] is True, capped
assert capped['lines'] == ['two', 'three'], capped
assert capped['warnings'] == 3, capped

empty = vb_ciw.classify_ciw_text('\\o nothing interesting\n')
out['empty'] = empty
assert empty['lines'] == [], empty
assert empty['otherLines'] == 1, empty


class FakeResult:
    def __init__(self, output):
        self.output = output
        self.status = 'success'


class FakeClient:
    def __init__(self, reads, listing=FD_LISTING, flush_error=None):
        self.reads = list(reads)
        self.listing = listing
        self.commands = []
        self.flushes = 0
        self.flush_error = flush_error

    def get_virtuoso_pid(self):
        return 4242

    def execute_skill(self, code, timeout=None):
        self.flushes += 1
        assert 'getWarn' in code, code
        if self.flush_error is not None:
            raise RuntimeError(self.flush_error)
        return FakeResult('""')

    def run_shell_command(self, command, timeout=None):
        self.commands.append(command)
        if '/proc/' in command:
            return FakeResult(self.listing)
        return FakeResult(self.reads.pop(0) if self.reads else '')


client = FakeClient([
    'SZ:120\n\\w *WARNING* first warning\n\\o chatter\n',
    'SZ:200\n\\w *WARNING* second warning\n',
    'SZ:200\n',
])
capture = vb_ciw.CiwCapture(client, first_window=1024, max_bytes=4096)
first = capture.capture()
out['first'] = first
assert first is not None and first['lines'] == ['*WARNING* first warning'], first
assert first['warnings'] == 1 and first['otherLines'] == 1, first
assert first['logPath'] == '/home/username/CDS.log.1' and first['pid'] == 4242, first
assert client.flushes == 1, client.flushes
assert '/proc/4242/fd' in client.commands[0], client.commands
assert 'tail -c 1024' in client.commands[1], client.commands[1]

second = capture.capture()
out['second'] = second
assert second is not None and second['lines'] == ['*WARNING* second warning'], second
assert 'tail -c +121' in client.commands[2], client.commands[2]

out['third'] = capture.capture()
assert out['third'] is None, out['third']
assert client.flushes == 3, client.flushes

broken = vb_ciw.CiwCapture(FakeClient(['SZ:10\n\\w *WARNING* still works\n'], flush_error='busy'))
out['flush_failure'] = broken.capture()
assert out['flush_failure'] is not None, out['flush_failure']
assert out['flush_failure']['lines'] == ['*WARNING* still works'], out['flush_failure']

no_log = vb_ciw.CiwCapture(FakeClient([], listing='total 0\n1 -> /dev/null\n'))
out['no_log'] = no_log.capture()
assert out['no_log'] is None, out['no_log']

garbage = vb_ciw.CiwCapture(FakeClient(['BusyError: lane poisoned']))
out['garbage'] = garbage.capture()
assert out['garbage'] is None, out['garbage']
assert garbage.path is None, garbage.path

rotating = vb_ciw.CiwCapture(FakeClient(['SZ:500\n\w first\n', 'SZ:100\n\w after rotation\n']))
rotating.capture()
restarted = rotating.capture()
out['rotated'] = restarted
assert restarted is not None, restarted
assert restarted['lines'] == ['after rotation'], restarted
assert restarted['truncated'] is True, restarted
assert rotating.cursor == 100, rotating.cursor

print(json.dumps(out))
