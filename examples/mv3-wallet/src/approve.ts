// The approval window: shows a dapp request and sends back the decision.

import { ask, type ApprovalRequest } from './shared'

const $ = (id: string) => document.getElementById(id)!

const TITLES: Record<ApprovalRequest['kind'], string> = {
  connect: 'Connect to this site?',
  'sign-message': 'Sign this message?',
  'sign-typed-data': 'Sign this data?',
  transaction: 'Send this transaction?'
}

const id = new URLSearchParams(window.location.search).get('id') ?? ''

async function main() {
  const request = await ask<ApprovalRequest | undefined>({ type: 'approval:get', id })
  if (!request) {
    window.close()
    return
  }
  $('title').textContent = TITLES[request.kind]
  $('origin').textContent = request.origin
  $('chain').textContent = request.chainName
  $('account').textContent = request.account
  $('details').textContent = request.details.join('\n\n')
  if (request.maxFee) {
    $('fee').textContent = `Network fee: at most ${request.maxFee}`
    $('fee').hidden = false
  }
  $('deploy').hidden = !request.isFirstDeploy
  $('device-note').hidden = request.kind === 'connect'
  $('approve').addEventListener('click', () => decide(true))
  $('reject').addEventListener('click', () => decide(false))
}

async function decide(approved: boolean) {
  await ask({ type: 'approval:resolve', id, approved })
  window.close()
}

void main()
