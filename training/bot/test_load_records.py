"""Unit tests for load_records semantics: separate value-target types and leakage safety.

The audit finding: mixed terminal-outcome and deep-search-root-score value targets were being fed
together as if directly comparable. load_records now canonicalises the source, counts the mix, and can
filter to one semantics WITHOUT ever hiding a train/validation family overlap behind the filter.
"""
import json
import tempfile
import unittest
from pathlib import Path

from train import load_records


def _row(game_id, family, split, source, value, terminal, player, planes=None):
    tv = 0 if terminal == 'DRAW' else (1 if terminal == player else -1)
    return {
        'schemaVersion': 1, 'gameId': game_id, 'openingFamily': family, 'split': split,
        'seed': 1, 'revision': 1, 'first': 'X', 'moves': [{'b': 0, 'c': 0, 'player': 'X'}],
        'player': player, 'encodingVersion': 'planes8-v1',
        'planes': planes if planes is not None else [0] * 648,
        'legalMask': [1] * 81, 'visitTarget': [1 / 81] * 81,
        'valueTarget': value, 'valueTargetSource': source,
        'terminalOutcome': terminal, 'terminalValue': tv,
    }


class LoadRecordsTests(unittest.TestCase):
    def _write(self, rows):
        d = Path(tempfile.mkdtemp())
        path = d / 'd.jsonl'
        path.write_text(''.join(json.dumps(r) + '\n' for r in rows))
        import hashlib
        manifest = {'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'records': len(rows), 'games': len(rows)}
        (d / 'd.jsonl.manifest.json').write_text(json.dumps(manifest))
        return path

    def test_sources_counted_and_not_silently_mixed(self):
        rows = [
            _row('g1', 'f1', 'train', 'terminal-outcome', 1.0, 'X', 'X'),
            _row('g2', 'f2', 'train', 'deep-search-root-score', 0.5, 'X', 'X'),
            _row('g3', 'f3', 'validation', 'terminal-outcome', -1.0, 'O', 'X'),
        ]
        manifest, splits = load_records(self._write(rows))
        self.assertEqual(manifest['valueTargetSources'], {'deep-search-root-score': 1, 'terminal-outcome': 2})
        self.assertTrue(manifest['mixedValueTargets'])
        self.assertEqual(len(splits['train']), 2)

    def test_filter_to_one_semantics_keeps_leakage_detection(self):
        rows = [
            _row('g1', 'f1', 'train', 'terminal-outcome', 1.0, 'X', 'X'),
            _row('g2', 'f2', 'train', 'deep-search-root-score', 0.5, 'X', 'X'),
            _row('g3', 'f3', 'validation', 'terminal-outcome', -1.0, 'O', 'X'),
        ]
        manifest, splits = load_records(self._write(rows), value_source='terminal-outcome')
        self.assertEqual(len(splits['train']), 1, 'only terminal-outcome training rows are kept')
        self.assertEqual(manifest['valueTargetRowsFilteredOut'], 1)
        # A search-source row that shares a gameId with a train row of ANOTHER split is still caught.
        leak = [
            _row('gX', 'fA', 'train', 'terminal-outcome', 1.0, 'X', 'X'),
            _row('gX', 'fB', 'validation', 'deep-search-root-score', 0.2, 'X', 'X'),
        ]
        with self.assertRaises(ValueError):
            load_records(self._write(leak), value_source='terminal-outcome')

    def test_wrong_terminal_perspective_is_rejected(self):
        bad = [_row('g1', 'f1', 'train', 'terminal-outcome', 1.0, 'X', 'X'),
               _row('g2', 'f2', 'validation', 'terminal-outcome', 1.0, 'X', 'X')]
        bad[0]['valueTarget'] = -1.0  # outcome says +1 but value says -1
        with self.assertRaises(ValueError):
            load_records(self._write(bad))


if __name__ == '__main__':
    unittest.main()


class ExternalRowTests(unittest.TestCase):
    """External (utttai-converted) rows have no game outcome; the loader must accept a declared
    non-terminal value source and REFUSE a row that mislabels itself as terminal."""

    def _write(self, rows):
        import hashlib
        d = Path(tempfile.mkdtemp()); path = d / 'd.jsonl'
        path.write_text(''.join(json.dumps(r) + '\n' for r in rows))
        (d / 'd.jsonl.manifest.json').write_text(json.dumps({'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'records': len(rows), 'games': len(rows)}))
        return path

    def _ext(self, split):
        return {'schemaVersion': 1, 'encodingVersion': 'planes8-v1', 'split': split, 'external': True,
                'planes': [0] * 648, 'legalMask': [1] * 81, 'visitTarget': [1 / 81] * 81,
                'valueTarget': 0.3, 'valueTargetSource': 'utttai-nmcts-root-value',
                'terminalOutcome': None, 'terminalValue': None}

    def test_external_rows_load_and_count(self):
        rows = [self._ext('external'), self._ext('external'),
                _row('g1', 'f1', 'validation', 'terminal-outcome', 1.0, 'X', 'X'),
                _row('g2', 'f2', 'train', 'terminal-outcome', 1.0, 'X', 'X')]
        manifest, splits = load_records(self._write(rows))
        self.assertEqual(manifest['valueTargetSources'], {'terminal-outcome': 2, 'utttai-nmcts-root-value': 2})
        self.assertEqual(len(splits['external']), 2)

    def test_external_row_cannot_masquerade_as_terminal(self):
        bad = self._ext('external'); bad['terminalValue'] = 1  # claims a terminal value it cannot have
        good = [_row('g1', 'f1', 'validation', 'terminal-outcome', 1.0, 'X', 'X'),
                _row('g2', 'f2', 'train', 'terminal-outcome', 1.0, 'X', 'X')]
        with self.assertRaises(ValueError):
            load_records(self._write([bad] + good))
