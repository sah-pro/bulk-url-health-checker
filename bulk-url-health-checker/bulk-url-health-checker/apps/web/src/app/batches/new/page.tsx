'use client';

import { useState, FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { createBatch, createBatchFromCsv } from '../../../lib/api';

export default function NewBatchPage() {
  const router = useRouter();
  const [mode, setMode] = useState<'paste' | 'csv'>('paste');
  const [text, setText] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (mode === 'paste' && text.trim().length === 0) {
      setError('Paste at least one URL.');
      return;
    }
    if (mode === 'csv' && !file) {
      setError('Choose a CSV file.');
      return;
    }

    setSubmitting(true);
    try {
      const { batch } =
        mode === 'paste'
          ? await createBatch(
              text
                .split(/[\n,]/)
                .map((l) => l.trim())
                .filter((l) => l.length > 0),
            )
          : await createBatchFromCsv(file!);
      router.push(`/batches/${batch.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create batch.');
      setSubmitting(false);
    }
  }

  return (
    <div>
      <h1 style={{ fontSize: 20, marginBottom: 16 }}>New batch</h1>

      <div className="section" style={{ display: 'flex', gap: 8 }}>
        <button type="button" onClick={() => setMode('paste')} disabled={mode === 'paste'}>
          Paste URLs
        </button>
        <button type="button" onClick={() => setMode('csv')} disabled={mode === 'csv'}>
          Upload CSV
        </button>
      </div>

      <form onSubmit={handleSubmit}>
        {mode === 'paste' ? (
          <div className="section">
            <label htmlFor="urls" style={{ display: 'block', marginBottom: 4, fontSize: 13, color: '#555' }}>
              One URL per line (or comma-separated). Blank lines and duplicates are ignored automatically.
            </label>
            <textarea
              id="urls"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={'https://example.com\nhttps://another-example.com'}
            />
          </div>
        ) : (
          <div className="section">
            <label htmlFor="csv" style={{ display: 'block', marginBottom: 4, fontSize: 13, color: '#555' }}>
              CSV file with a &quot;url&quot; column (or the first column is used if none is named
              &quot;url&quot;). Max 5MB.
            </label>
            <input
              id="csv"
              type="file"
              accept=".csv,text/csv"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </div>
        )}

        {error && <p className="error-cell">{error}</p>}

        <button type="submit" className="primary" disabled={submitting}>
          {submitting ? 'Creating...' : 'Create batch'}
        </button>
      </form>
    </div>
  );
}
