import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { parseResumePdf } from '../utils/api';

/**
 * Opens the OS file picker for a PDF, parses on server, then either navigates to /resumes/new
 * with prefilled state or calls onParsed(data).
 */
export default function ResumePdfUploadButton({
  children = 'Upload resume (PDF)',
  className = 'btn btn-secondary',
  fullWidth = false,
  disabled = false,
  /** If set, called with parsed payload instead of navigating */
  onParsed,
  onError
}) {
  const inputRef = useRef(null);
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);

  const pick = () => {
    inputRef.current?.click();
  };

  const onChange = async e => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('pdf', file);
      const { data } = await parseResumePdf(fd);
      if (onParsed) onParsed(data);
      else navigate('/resumes/new', { state: { parsedData: data } });
    } catch (err) {
      const msg = err.response?.data?.error || 'Could not parse PDF.';
      if (onError) onError(msg);
      else alert(msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept=".pdf,application/pdf"
        className="visually-hidden-file"
        aria-label="Choose resume PDF file"
        tabIndex={-1}
        onChange={onChange}
      />
      <button
        type="button"
        className={className}
        style={fullWidth ? { width: '100%', justifyContent: 'center' } : undefined}
        onClick={pick}
        disabled={disabled || busy}
        title="Choose a PDF from your computer"
      >
        {busy ? (
          <>
            <span className="spinner" style={{ width: 14, height: 14, borderWidth: 2, marginRight: 8 }} />
            Parsing…
          </>
        ) : (
          children
        )}
      </button>
    </>
  );
}
