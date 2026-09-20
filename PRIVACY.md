# Privacy policy

Tab Stash - Hister Bridge processes data only to synchronize Tab Stash bookmarks with the Hister server configured by the user.

## Data processed

The extension may process and transmit the following data to the configured Hister server:

- bookmark URLs, titles, folder names, and derived labels;
- extracted text and HTML from bookmarked pages;
- bookmarked PDF contents;
- an optional Hister access token supplied by the user.

This corresponds to the Firefox data categories `bookmarksInfo`, `browsingActivity`, and `websiteContent` declared in `manifest.json`.

## Storage and transmission

Configuration, synchronization state, and the optional access token are stored in Firefox extension storage on the user's device. Page and bookmark data is sent only to the Hister URL selected by the user. The project author does not operate a collection service and does not receive this data.

Defuddle extraction runs locally inside the extension. When the extension must fetch a bookmarked page or PDF, the destination website receives a normal network request.

Data retained by Hister is governed by the user's Hister deployment and remains there until removed by the user or that service. Uninstalling the extension removes its Firefox-managed local storage but does not delete data already stored by Hister.

## User controls

Users can change the Hister URL, remove the access token, disable mobile polling, or uninstall the extension from Firefox at any time. Users should use their Hister deployment's controls to inspect or delete archived data.

## Changes and contact

Material changes to this policy will be published in this repository. Questions can be filed through the project's GitHub issue tracker.

Effective: September 20, 2026.
