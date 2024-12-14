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

function buildFastaHeader(meta: MetadataEntry | undefined, fields: string[], accessionVersion: string): string {
  if (!meta) {
    return accessionVersion // If no metadata exists, use accessionVersion as header
  }

  const values = fields.map(field => meta[field] ?? '')
  if (values.every(v => v === '')) {
    return accessionVersion // If all requested fields are empty/undefined, use accessionVersion
  }
  
  return values.join('|')
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
    const { sequencesUrl, metadataUrl, filterForValidDate, fields = 'displayName,sampleCollectionDate',  } = req.query
    const fieldsSplit = (fields as string).split(',')

    const filterForValidDateString = filterForValidDate as string
    
    if (!sequencesUrl || !metadataUrl) {
      return res.status(400).json({ error: 'Both sequencesUrl and metadataUrl are required' })
    }


    // Fetch both JSON files
    const [sequences, metadataOriginal] = await Promise.all([
      fetchAndParseJson(sequencesUrl as string),
      fetchAndParseJson(metadataUrl as string)
    ])

    

    const metadata = Object.fromEntries(
      metadataOriginal.map((entry: MetadataEntry) => [entry.accessionVersion, entry])
    )

    // Build new FASTA - include all sequences
    let newFasta = ''
    sequences.forEach(({accessionVersion, main}: SequenceEntry) => {
      const meta = metadata[accessionVersion]
      if(filterForValidDateString){
        const date = meta[filterForValidDateString]
        if(date && !/\d{4}-\d{2}-\d{2}/.test(date)){
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