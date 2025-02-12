import { NextApiRequest, NextApiResponse } from 'next'
import axios from 'axios'

interface MetadataEntry {
  accessionVersion: string
  [key: string]: any  // Other metadata fields
}

interface SequenceEntry {
  accessionVersion: string
  main: string
}

/**
 * Helper to append a query parameter for dataFormat.
 * If the URL already has query parameters, append with '&',
 * otherwise start with '?'.
 */
function appendDataFormat(url: string, dataFormat: string): string {
  return url + (url.includes('?') ? '&' : '?') + 'dataFormat=' + dataFormat;
}

/**
 * Fetch a TSV file from the given URL and parse it into an array of objects.
 * Assumes the first line is a header row.
 */
async function fetchAndParseTSV(url: string): Promise<MetadataEntry[]> {
  const response = await axios.get(url, { responseType: 'text' })
  return parseTSV(response.data)
}

function parseTSV(tsvText: string): MetadataEntry[] {
  const lines = tsvText.split(/\r?\n/).filter(line => line.trim() !== '')
  if (lines.length === 0) return []

  const headers = lines[0].split('\t')
  const entries: MetadataEntry[] = []

  // Process each row (skip the header row)
  for (let i = 1; i < lines.length; i++) {
    const row = lines[i].split('\t')
    const entry: MetadataEntry = {} as MetadataEntry
    headers.forEach((header, index) => {
      entry[header] = row[index] ?? ''
    })
    entries.push(entry)
  }
  return entries
}

/**
 * Fetch a FASTA file from the given URL and parse it into an array of sequence objects.
 */
async function fetchAndParseFASTA(url: string): Promise<SequenceEntry[]> {
  const response = await axios.get(url, { responseType: 'text' })
  return parseFASTA(response.data)
}

function parseFASTA(fastaText: string): SequenceEntry[] {
  const lines = fastaText.split(/\r?\n/)
  const entries: SequenceEntry[] = []
  let currentHeader: string | null = null
  let currentSequence = ''

  for (const line of lines) {
    if (line.startsWith('>')) {
      // If we were building a sequence, store it before starting a new one.
      if (currentHeader) {
        entries.push({ accessionVersion: currentHeader, main: currentSequence })
      }
      currentHeader = line.slice(1).trim() // Remove '>' and trim whitespace
      currentSequence = ''
    } else {
      if (line.trim() !== '') {
        currentSequence += line.trim()
      }
    }
  }
  // Push the last sequence if present.
  if (currentHeader) {
    entries.push({ accessionVersion: currentHeader, main: currentSequence })
  }
  return entries
}

/**
 * Build a FASTA header line.
 * If the metadata for the sequence is missing or all specified fields are empty,
 * the accessionVersion is used as the header.
 */
function buildFastaHeader(meta: MetadataEntry | undefined, fields: string[], accessionVersion: string): string {
  if (!meta) {
    return accessionVersion
  }
  const values = fields.map(field => meta[field] ?? '')
  if (values.every(v => v === '')) {
    return accessionVersion
  }
  return values.join('|')
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  // Handle OPTIONS preflight request
  if (req.method === 'OPTIONS') {
    return res.status(200).end()
  }

  try {
    const {
      sequencesUrl,
      metadataUrl,
      filterForValidDate,
      fields = 'displayName,sampleCollectionDate'
    } = req.query

    if (!sequencesUrl || !metadataUrl) {
      return res.status(400).json({ error: 'Both sequencesUrl and metadataUrl are required' })
    }

    const fieldsSplit = (fields as string).split(',')

    // Append the required dataFormat parameters.
    const sequencesUrlWithFormat = appendDataFormat(sequencesUrl as string, 'fasta')
    const metadataUrlWithFormat = appendDataFormat(metadataUrl as string, 'tsv')

    // Fetch and parse the sequences (FASTA) and metadata (TSV) concurrently.
    const [sequences, metadataOriginal] = await Promise.all([
      fetchAndParseFASTA(sequencesUrlWithFormat),
      fetchAndParseTSV(metadataUrlWithFormat)
    ])

    // Build a lookup for metadata by accessionVersion.
    const metadata = Object.fromEntries(
      metadataOriginal.map((entry: MetadataEntry) => [entry.accessionVersion, entry])
    )

    let newFasta = ''
    sequences.forEach(({ accessionVersion, main }) => {
      const meta = metadata[accessionVersion]
      if (filterForValidDate) {
        // If a valid date is required, and the date is not in the format YYYY-MM-DD, skip this sequence.
        const date = meta ? meta[filterForValidDate as string] : null
        if (date && !/\d{4}-\d{2}-\d{2}/.test(date)) {
          return
        }
      }
      const header = buildFastaHeader(meta, fieldsSplit, accessionVersion)
      newFasta += `>${header}\n${main}\n`
    })

    return res.status(200).send(newFasta)
  } catch (error) {
    console.error(error)
    return res.status(500).json({ 
      error: 'Failed to process files',
      details: error instanceof Error ? error.message : 'Unknown error'
    })
  }
}
