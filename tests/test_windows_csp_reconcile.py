"""Offline regression coverage for retained sorting-worker snapshot evidence."""
import json
from pathlib import Path
import tempfile
import unittest

import windows_csp_reconcile as reconcile


class WorkerEvidenceTests(unittest.TestCase):
    def summarize(self, captures):
        with tempfile.TemporaryDirectory() as directory:
            live = Path(directory)
            for name, value in captures.items():
                (live / name).write_text(json.dumps(value), encoding='utf-8')
            return reconcile.summarize_worker(live)

    def test_early_nonzero_survives_final_zero(self):
        worker, nonzero = self.summarize({
            'scene-progress.json': [
                {'utc': 'early', 'workerMessages': [{'count': 40, 'orderLength': 40, 'orderFirst': [2, 1]}]},
                {'utc': 'late', 'workerMessages': [{'count': 0}]},
            ],
            'capture-final.json': {'workers': [{}], 'workerMessages': [{'count': 0}]},
        })
        self.assertEqual(nonzero['verdict'], 'OBSERVED')
        self.assertEqual(worker['observedCounts'], [0, 40])
        self.assertEqual(worker['retainedCounts'], [0])
        self.assertEqual(worker['resultMessageObservations'], 3)
        self.assertEqual(worker['capturedSnapshotCount'], 3)
        self.assertEqual(worker['nonzeroResultEvidence'], [{
            'file': 'scene-progress.json', 'snapshotIndex': 0, 'utc': 'early',
            'messageIndex': 0, 'count': 40, 'orderLength': 40, 'orderFirst': [2, 1],
        }])
        self.assertIn('not establish sorting correctness', nonzero['reason'])

    def test_singleton_snapshot_shapes(self):
        for name in ['gpu-before-native.json', 'contact-scene.json']:
            with self.subTest(name=name):
                worker, nonzero = self.summarize({
                    name: {'utc': 'snapshot', 'workerMessages': [{'count': 40}]},
                    'capture-final.json': {'workers': [], 'workerMessages': [{'count': 0}]},
                })
                self.assertEqual(nonzero['verdict'], 'OBSERVED')
                self.assertEqual(worker['nonzeroResultEvidence'][0]['file'], name)
                self.assertIsNone(worker['nonzeroResultEvidence'][0]['snapshotIndex'])

    def test_nonzero_final_capture(self):
        worker, nonzero = self.summarize({
            'capture-final.json': {'workers': [{}], 'workerMessages': [{'count': 40}]},
            'scene-progress.json': [],
        })
        self.assertEqual(nonzero['verdict'], 'OBSERVED')
        self.assertEqual(worker['observedCounts'], [40])

    def test_no_positive_evidence(self):
        for messages in [[], [{'count': 0}], [{'keys': ['unrelated']}]]:
            with self.subTest(messages=messages):
                worker, nonzero = self.summarize({
                    'gpu-before-native.json': {'workerMessages': []},
                    'scene-progress.json': [{'workerMessages': messages}, {}],
                    'capture-final.json': {'workers': [], 'workerMessages': []},
                })
                self.assertEqual(nonzero['verdict'], 'UNVERIFIED')
                self.assertEqual(worker['nonzeroResultEvidence'], [])
                self.assertNotEqual(worker['verdict'], 'FAIL')


if __name__ == '__main__':
    unittest.main()
