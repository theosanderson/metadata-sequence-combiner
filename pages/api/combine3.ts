import { NextApiRequest, NextApiResponse } from 'next'
import axios from 'axios'
import readline from 'readline'

interface MetadataEntry {
  accessionVersion: string
  [key: string]: any
}

interface SequenceEntry {
  accessionVersion: string
  main: string
}

/**
 * Append the dataFormat parameter to a URL.
 */
function appendDataFormat(url: string, dataFormat: string): string {
  return url + (url.includes('?') ? '&' : '?') + 'dataFormat=' + dataFormat;
}

/**
 * Build a FASTA header from a metadata object and requested fields.
 * If no metadata is provided or all requested fields are empty,
 * the accessionVersion is used.
 */
function buildFastaHeader(meta: MetadataEntry | undefined, fields: string[], accessionVersion: string): string {
  if (!meta) {
    return accessionVersion;
  }
  const values = fields.map(field => meta[field] ?? '');
  if (values.every(v => v === '')) {
    return accessionVersion;
  }
  return values.join('|');
}

/**
 * Async generator to stream metadata entries from a TSV source.
 * Expects the first non-empty line to be a header row.
 */
async function* streamMetadata(tsvStream: NodeJS.ReadableStream): AsyncGenerator<MetadataEntry> {
  const rl = readline.createInterface({ input: tsvStream, crlfDelay: Infinity });
  let headers: string[] = [];
  let isFirstLine = true;
  for await (const line of rl) {
    if (line.trim() === '') continue;
    if (isFirstLine) {
      headers = line.split('\t');
      isFirstLine = false;
      continue;
    }
    const row = line.split('\t');
    const entry: MetadataEntry = {} as MetadataEntry;
    headers.forEach((header, index) => {
      entry[header] = row[index] ?? '';
    });
    yield entry;
  }
}

/**
 * Async generator to stream FASTA entries.
 * This parser assumes that a header line starts with '>' and that all
 * subsequent lines (until the next header) are part of the sequence.
 */
async function* streamFasta(fastaStream: NodeJS.ReadableStream): AsyncGenerator<SequenceEntry> {
  const rl = readline.createInterface({ input: fastaStream, crlfDelay: Infinity });
  let currentHeader: string | null = null;
  let currentSequence = '';

  for await (const line of rl) {
    if (line.startsWith('>')) {
      if (currentHeader !== null) {
        // Yield the previous entry
        yield { accessionVersion: currentHeader, main: currentSequence };
      }
      currentHeader = line.slice(1).trim();
      currentSequence = '';
    } else {
      currentSequence += line.trim();
    }
  }
  if (currentHeader !== null) {
    yield { accessionVersion: currentHeader, main: currentSequence };
  }
}

/**
 * Next.js API handler that streams two remote files (metadata TSV and sequences FASTA),
 * pairs each FASTA entry with its metadata (in the same order), and writes the final FASTA on the fly.
 */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  // Handle preflight OPTIONS request
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    const {
      sequencesUrl,
      metadataUrl,
      filterForValidDate,
      fields = 'displayName,sampleCollectionDate'
    } = req.query;

    if (!sequencesUrl || !metadataUrl) {
      res.status(400).json({ error: 'Both sequencesUrl and metadataUrl are required' });
      return;
    }

    // Split the requested metadata fields
    const fieldsSplit = (fields as string).split(',');
    const filterForValidDateString = filterForValidDate as string;

    // Append the proper query parameters
    const fastaUrl = appendDataFormat(sequencesUrl as string, 'fasta');
    const tsvUrl = appendDataFormat(metadataUrl as string, 'tsv');

    // Get streaming responses from both URLs.
    const [fastaResponse, tsvResponse] = await Promise.all([
      axios.get(fastaUrl, { responseType: 'stream' }),
      axios.get(tsvUrl, { responseType: 'stream' })
    ]);

    // Create streams from the response data.
    const fastaStream = fastaResponse.data;
    const tsvStream = tsvResponse.data;

    // Set response headers for streaming text output.
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');

    // Create async iterators for both streams.
    const fastaIterator = streamFasta(fastaStream);
    const metadataIterator = streamMetadata(tsvStream);

    // Process the two streams in lock-step.
    // Process the two streams in lock–step.
while (true) {
    // Get the next FASTA entry and metadata row concurrently.
    const [fastaResult, metadataResult] = await Promise.all([
      fastaIterator.next(),
      metadataIterator.next()
    ]);
  
    // If either stream is done, we stop.
    if (fastaResult.done || metadataResult.done) break;
  
    const fastaEntry = fastaResult.value;
    const metadataEntry = metadataResult.value;
  
    // Here we check that the FASTA id matches the metadata accessionVersion.
    if (metadataEntry.accessionVersion && fastaEntry.accessionVersion !== metadataEntry.accessionVersion) {
      console.error(
        `Accession mismatch: FASTA id "${fastaEntry.accessionVersion}" does not match metadata accession "${metadataEntry.accessionVersion}".`
      );
      
      throw new Error('Accession mismatch between FASTA and metadata');
     
    }
  
    // Optionally, also check for a valid date if requested.
    if (filterForValidDateString) {
      const date = metadataEntry[filterForValidDateString];
      if (date && !/\d{4}-\d{2}-\d{2}/.test(date)) {
        continue; // Skip if the date is invalid.
      }
    }
  
    // Build the new header using metadata fields.
    const header = buildFastaHeader(metadataEntry, fieldsSplit, fastaEntry.accessionVersion);
    res.write(`>${header}\n${fastaEntry.main}\n`);
    
  }

    // End the response stream.
    res.end();
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: 'Failed to process files',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
}
