import _ from 'lodash'
import axios from 'axios'
import ms from 'ms'

const QUESTIONS_CACHE_TIMEOUT = ms('10 sec')
const KNOWLEDGEBASE_NAME = 'botpress'

// Handles QnA Maker API downcasing all key-values in metadata
const markUpperCase = str => str.replace(/([A-Z])/g, 'sssooo$1sss')
const restoreUpperCase = str =>
  str
    .split('sss')
    .map(chunk => (chunk.startsWith('ooo') ? chunk.slice(3).toUpperCase() : chunk))
    .join('')

const qnaItemData = ({ questions, answer, metadata }) => ({
  questions,
  answer,
  ..._.fromPairs(metadata.map(({ name, value }) => [restoreUpperCase(name), restoreUpperCase(value)])),
  enabled: metadata.find(({ name }) => name === 'enabled').value === 'true'
})

export default class Storage {
  constructor({ bp, config }) {
    const baseURL = 'https://westus.api.cognitive.microsoft.com/qnamaker/v4.0'
    const headers = { 'Ocp-Apim-Subscription-Key': config.microsoftQnaMakerApiKey }
    Object.assign(this, { bp, client: axios.create({ baseURL, headers }) })
  }

  async initialize() {
    const isBpKnowledgbase = ({ name }) => name === KNOWLEDGEBASE_NAME
    const { data: { knowledgebases: initialKnowledgebases } } = await this.client.get('/knowledgebases/')
    const existingKb = initialKnowledgebases.find(isBpKnowledgbase)
    if (existingKb) {
      this.knowledgebase = existingKb
    } else {
      await this.client.post('/knowledgebases/create', { name: KNOWLEDGEBASE_NAME, qnaList: [], urls: [], files: [] })
      this.knowledgebase = (await this.client.get('/knowledgebases/')).find(isBpKnowledgbase)
    }

    this.endpointKey = (await this.client.get('/endpointkeys')).data.primaryEndpointKey
  }

  publish = () => this.client.post(`/knowledgebases/${this.knowledgebase.id}`)

  async saveQuestion(data, id = null) {
    // TODO: existing questions should be updated rather than deleted and created with new params
    await this.client.patch(`/knowledgebases/${this.knowledgebase.id}`, {
      add: {
        qnaList: [
          {
            id: 0,
            answer: data.answer,
            questions: data.questions,
            source: 'Botpress API-call',
            metadata: _.chain(data)
              .pick(['enabled', 'action', 'redirectFlow', 'redirectNode'])
              .toPairs()
              .map(([name, value]) => ({
                name: _.isString(name) ? markUpperCase(name) : name,
                value: _.isString(value) ? markUpperCase(value) : value
              }))
              .filter(({ value }) => !_.isUndefined(value))
              .value()
          }
        ]
      },
      delete: {
        ids: id ? [id] : []
      }
    })
    this.questions = null
    await this.publish()
    return id
  }

  async fetchQuestions() {
    if (!this.questions || new Date() - this.questionsCached > QUESTIONS_CACHE_TIMEOUT) {
      const { data: { qnaDocuments } } = await this.client.get(`/knowledgebases/${this.knowledgebase.id}/test/qna/`)
      this.questions = qnaDocuments
      this.questionsCached = new Date()
    }

    return this.questions
  }

  async getQuestion(id) {
    const questions = await this.fetchQuestions()
    return questions.find(({ id: qnaId }) => qnaId === id)
  }

  async questionsCount() {
    const questions = await this.fetchQuestions()
    return questions.length
  }

  async getQuestions({ limit, offset } = {}) {
    let questions = await this.fetchQuestions()
    if (typeof limit !== 'undefined' && typeof offset !== 'undefined') {
      questions = questions.slice(offset, offset + limit)
    }

    return questions.map(answer => ({ id: answer.id, data: qnaItemData(answer) }))
  }

  async getAnswers(question) {
    const { data: { answers } } = await axios.post(
      `/qnamaker/knowledgebases/${this.knowledgebase.id}/generateAnswer`,
      { question },
      { baseURL: this.knowledgebase.hostName, headers: { Authorization: `EndpointKey ${this.endpointKey}` } }
    )

    return _.orderBy(answers, ['confidence'], ['desc']).map(answer => ({
      ..._.pick(answer, ['questions', 'answer', 'id']),
      confidence: answer.score,
      ...qnaItemData(answer)
    }))
  }

  async deleteQuestion(id) {
    await this.client.patch(`/knowledgebases/${this.knowledgebase.id}`, { delete: { ids: [id] } })
    this.questions = this.questions && this.questions.filter(({ id: qnaId }) => qnaId !== id)
    await this.publish()
  }
}
