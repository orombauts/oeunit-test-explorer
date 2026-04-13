- Keep on using openedge-project.json file
  - to detect the OE projects
  - to deriver the DLC path (we need to parse manually, the openedge-abl-lsp api can't return that)
- propath from openedge-project.json file should be retrieved from openedge-abl-lsp api, advantages:
  - we get only the propath entries and not the source entries (correct?)
  - the env variable is already expanded
- **how to know if propath is not already set by ini file, and can we just then impose the propath from the openedge-project.json?**
- Check if readme file mentions dependency on openedge-abl-lsp extension

Issues when oeunitserver is not running
- verify first time should auto-start server. Does not happen automatically in multi-project workspace because one is asked to choose the project for which server should start
- verify first time from within editor pressing start icon on test case of file, one has to choose the projeect in the multi-project workspace. And after started the test runner goes into error
