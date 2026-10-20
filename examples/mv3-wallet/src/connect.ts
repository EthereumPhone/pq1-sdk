// The connect page (a tab, not the action popup: Chrome closes popups while
// the WebHID device picker is open). Grants the extension access to the PQ1,
// then lets the user pick an account. The service worker does all the
// talking to the device.

import { getUserMessage, PQ1_ERROR_MESSAGES, type Pq1Account } from 'pq1-sdk'
import { getWebHidSupport, notifyPermissionGranted, requestPq1Permission } from 'pq1-sdk/extension'

import { ask, type WalletSettings } from './shared'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

const connectButton = $<HTMLButtonElement>('connect')
const status = $('status')
const error = $('error')

if (!getWebHidSupport().supported) {
  $('unsupported').textContent = PQ1_ERROR_MESSAGES.unsupported
  $('unsupported').hidden = false
  connectButton.disabled = true
}

connectButton.addEventListener('click', async () => {
  error.textContent = ''
  try {
    // Must run in the click handler: the picker needs a user gesture.
    const device = await requestPq1Permission()
    if (!device) {
      status.textContent = 'No PQ1 was chosen.'
      return
    }
    await notifyPermissionGranted()
    status.textContent = 'Reading accounts… If your PQ1 asks for its PIN, enter it on the device.'
    const accounts = await ask<Pq1Account[]>({ type: 'pq1:list-accounts', start: 0, count: 5 })
    const settings = await ask<WalletSettings>({ type: 'pq1:get-settings' })
    renderAccounts(accounts, settings.account)
    status.textContent = ''
  } catch (e) {
    status.textContent = ''
    error.textContent = e instanceof Error ? e.message : getUserMessage(e)
  }
})

function renderAccounts(accounts: Pq1Account[], selected?: Pq1Account) {
  const list = $('account-list')
  list.replaceChildren(
    ...accounts.map((account) => {
      const item = document.createElement('li')
      const label = document.createElement('code')
      label.textContent = `#${account.index}  ${account.address}`
      const verify = document.createElement('button')
      verify.textContent = 'Check on PQ1'
      verify.addEventListener('click', () =>
        run(verify, 'Compare the address on your PQ1 with this one, then confirm there.', () =>
          ask({ type: 'pq1:show-address', index: account.index })
        )
      )
      const use = document.createElement('button')
      use.className = 'primary'
      use.textContent = selected?.address === account.address ? 'In use' : 'Use'
      use.disabled = selected?.address === account.address
      use.addEventListener('click', () =>
        run(use, '', async () => {
          await ask({ type: 'pq1:select-account', account })
          renderAccounts(accounts, account)
        })
      )
      item.append(label, verify, use)
      return item
    })
  )
  $('accounts').hidden = false
}

async function run(button: HTMLButtonElement, hint: string, action: () => Promise<unknown>) {
  button.disabled = true
  error.textContent = ''
  status.textContent = hint
  try {
    await action()
    status.textContent = ''
  } catch (e) {
    status.textContent = ''
    error.textContent = e instanceof Error ? e.message : getUserMessage(e)
  } finally {
    button.disabled = false
  }
}
