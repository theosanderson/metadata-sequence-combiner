import { NextApiRequest, NextApiResponse } from 'next'
import axios from 'axios'

interface MetadataEntry {
  accessionVersion: string
  [key: string]: any  // Allow for flexible metadata fields
}

interface SequenceEntry {
  accessionVersion: string
  main: string
}

async function fetchAndParseJson(url: string): Promise<any> {
  const response = await axios.get(url)
  return response.data
}

function isValidDate(dateStr: string): boolean {
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/
  if (!dateRegex.test(dateStr)) return false
  
  const date = new Date(dateStr)
  return date instanceof Date && !isNaN(date.getTime())
}

function buildFastaHeader(meta: MetadataEntry, fields: string[]): string {
  return fields
    .map(field => meta[field])
    .filter(value => value !== undefined)
    .join('|')
}

function hasRequiredFields(meta: MetadataEntry, fields: string[]): boolean {
  return fields.every(field => {
    const value = meta[field]
    if (field === 'sampleCollectionDate') {
      return value && isValidDate(value)
    }
    return value !== undefined && value !== null && value !== ''
  })
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Credentials', 'true')
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS')
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  )

  // Handle OPTIONS request
  if (req.method === 'OPTIONS') {
    return res.status(200).end()
  }

  try {
    const { sequencesUrl, metadataUrl, fields = 'displayName,sampleCollectionDate' } = req.query

    if (!sequencesUrl || !metadataUrl) {
      return res.status(400).json({ error: 'Both sequencesUrl and metadataUrl are required' })
    }

    // Convert fields string to array
    const headerFields = (fields as string).split(',').map(f => f.trim())

    if (headerFields.length === 0) {
      return res.status(400).json({ error: 'At least one field must be specified' })
    }

    // Fetch both JSON files
    const [sequences, metadataOriginal] = await Promise.all([
      fetchAndParseJson(sequencesUrl as string),
      fetchAndParseJson(metadataUrl as string)
    ])

    const metadata = Object.fromEntries(
      metadataOriginal.data.map((entry: MetadataEntry) => [entry.accessionVersion, entry])
    )

    // Build new FASTA
    let newFasta = ''
    sequences.data.forEach(({accessionVersion, main}: SequenceEntry) => {
      const meta = metadata[accessionVersion]
      if (meta && hasRequiredFields(meta, headerFields)) {
        const header = buildFastaHeader(meta, headerFields)
        newFasta += `>${header}\n${main}\n`
      }
    })

    if (!newFasta) {
      return res.status(404).json({ 
        error: 'No valid sequences found with the specified metadata fields' 
      })
    }

    return res.status(200).send(newFasta)
  } catch (error) {
    console.error(error)
    return res.status(500).json({ 
      error: 'Failed to process files',
      details: error instanceof Error ? error.message : 'Unknown error'
    })
  }
}