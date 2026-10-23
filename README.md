# Love Meter — jeu fictif de compatibilité

Petit projet HTML/CSS/JavaScript avec un serveur Node.js, une sauvegarde locale en JSON et une page d’administration protégée. Il ne nécessite aucune bibliothèque à installer.

## Ce qu’il fait

- Demande le nom complet de deux personnes.
- Enregistre le score du premier test. Un même duo retrouve ensuite exactement le même score, quel que soit l’ordre des noms.
- Normalise les majuscules, les espaces et les accents pour réduire les doublons.
- Applique les règles spéciales actives avant de calculer un score classique.
- Fournit une page `admin.html` avec statistiques, recherche, suppression des tests et gestion des règles (ajout, modification, activation/désactivation et suppression).
- Garde les règles de compatibilité dans le fichier de données côté serveur : elles ne sont pas envoyées à la page du jeu.
- Utilise seulement les modules intégrés à Node.js, sans `npm install`.

## Règles spéciales préchargées

J’ai interprété la règle de groupe de cette façon : chaque nom contenant **Oyane**, **Obame** ou **Viviane** associé à un nom contenant **Mouchfik**, **Omotoyossi** ou **Parfait** déclenche 100 %. Cela couvre notamment Omotoyossi/Viviane, Parfait/Viviane, Parfait/Oyane et Parfait/Obame, dans les deux sens.

Une règle supplémentaire donne 100 % quand un nom contient **Obame** et l’autre contient **Esthimée**, même si les autres prénoms ou noms sont différents.

Les mots-clés sont recherchés comme des mots entiers dans le nom complet : « Obame » correspond à « Jean Obame », mais pas à « Obamessi ». Tu peux modifier ces règles depuis l’administration dès le premier lancement.

## Installation et lancement

Il faut Node.js 20 ou plus récent.

1. Dans un terminal, ouvre le dossier du projet.
2. Lance `node setup.js` et choisis un mot de passe administrateur de 12 caractères minimum. Il sera enregistré dans `.env`, pas dans le code source.
3. Lance `node server.js`.
4. Ouvre `http://127.0.0.1:3000` pour jouer.
5. Ouvre `http://127.0.0.1:3000/admin.html` pour te connecter à l’administration avec le mot de passe choisi.

Arrête le serveur avec `Ctrl+C`. Les données restent dans `data/lovemeter.json` après l’arrêt du serveur.

## Sur Android avec Termux

Après avoir extrait le ZIP dans un dossier accessible :

```sh
cd /chemin/vers/lovemeter-project
node setup.js
node server.js
```

Puis ouvre `http://127.0.0.1:3000` dans le navigateur du téléphone. Remplace le chemin d’exemple par le vrai chemin où tu as extrait les fichiers.

## Données et confidentialité

Les noms complets et les scores sont stockés en clair dans `data/lovemeter.json`. Ce fichier est privé : ne l’envoie pas publiquement et fais une copie de sauvegarde avant toute modification manuelle. La page du jeu n’a pas de recherche publique ni de liste des tests des autres personnes.

Les scores sont une fiction ludique et ne permettent pas de mesurer les vrais sentiments. Comme le serveur conserve les noms complets, préviens les personnes si tu leur demandes de participer et n’utilise pas ce prototype pour publier des informations privées.

## Important avant une mise en ligne publique

Le serveur écoute par défaut seulement sur `127.0.0.1`, pour éviter de l’exposer au réseau par accident. Pour un test sur le réseau local, tu peux ajouter `HOST=0.0.0.0` dans `.env`, mais cela rend le serveur accessible depuis le réseau local. Ne le publie pas sur Internet tel quel : une vraie mise en ligne doit ajouter HTTPS correctement configuré, une protection adaptée au déploiement choisi et une politique claire de conservation/suppression des noms. Les sessions d’administration de ce prototype sont conservées en mémoire et prennent fin au redémarrage du serveur.
