import { NextApiRequest, NextApiResponse } from 'next'
import axios from 'axios'

interface MetadataEntry {
  accessionVersion: string
  displayName: string
  sampleCollectionDate: string
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
  // Check if date matches YYYY-MM-DD format
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/
  if (!dateRegex.test(dateStr)) return false
  
  // Check if it's a valid date
  const date = new Date(dateStr)
  return date instanceof Date && !isNaN(date.getTime())
}

function processMetadata(data: any): Map<string, MetadataEntry> {
  const metadata = new Map<string, MetadataEntry>()

  
  data.data.forEach((entry: any) => {
    metadata.set(entry.accessionVersion, {
      accessionVersion: entry.accessionVersion,
      displayName: entry.displayName,
      sampleCollectionDate: entry.sampleCollectionDate
    })
  })
  
  return metadata
}

function processSequences(data: any): Map<string, string> {
  const sequences = new Map<string, string>()
  
  data.data.forEach((entry: SequenceEntry) => {
    sequences.set(entry.accessionVersion, entry.main)
  })
  
  return sequences
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  try {
    const { sequencesUrl, metadataUrl } = req.query

    if (!sequencesUrl || !metadataUrl) {
      return res.status(400).json({ error: 'Both sequencesUrl and metadataUrl are required' })
    }

    // Fetch both JSON files
    const [sequences, metadataOriginal] = await Promise.all([
      fetchAndParseJson(sequencesUrl as string),
      fetchAndParseJson(metadataUrl as string)
    ])

    const metadata = Object.fromEntries(metadataOriginal.data.map((entry: any) => [entry.accessionVersion, entry]))

    //return res.status(200).json({ metadata, sequences })


    // Build new FASTA
    let newFasta = ''
    sequences.forEach(({accessionVersion, main})=> {
      const meta = metadata[accessionVersion]
      if (meta && isValidDate(meta.sampleCollectionDate)) {
        newFasta += `>${meta.displayName}|${meta.sampleCollectionDate}\n${main}\n`
      }
    })

    return res.status(200).send(newFasta)
  } catch (error) {
    console.error(error)
    res.status(500).json({ error: 'Failed to process files' })
  }
}
